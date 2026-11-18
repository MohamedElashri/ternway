use crate::{models::*, storage::Store, AppError, AppState};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOrigin {
    alias: String,
    linked: bool,
    server_id: String,
    name: String,
    username: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInspection {
    existing: Vec<String>,
    missing: Vec<String>,
    origins: Vec<ImportOrigin>,
}

#[derive(Debug)]
pub struct ImportedConnection {
    pub server: ServerProfile,
    pub created: bool,
    pub updated: bool,
    pub reconnect: bool,
}

fn source_path(source: &str) -> Result<String, String> {
    if source.len() > 8192 {
        return Err("Import path is too long".into());
    }
    let path = if source.trim().is_empty() {
        dirs::home_dir()
            .ok_or("Home directory unavailable")?
            .join(".ssh/config")
    } else {
        crate::ssh::expand_path(source)
    };
    Ok(path
        .canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned())
}

fn source_key(source: &str, alias: &str, draft: &ServerDraft) -> Result<String, String> {
    if source.len() > 8192 || alias.is_empty() || alias.len() > 1024 {
        return Err("Invalid import source".into());
    }
    serde_json::to_string(&(
        source_path(source)?,
        alias,
        draft.auth_method == AuthMethod::OpenSsh,
    ))
    .map_err(|e| e.to_string())
}
fn fingerprint(draft: &ServerDraft) -> serde_json::Value {
    serde_json::json!([
        draft.host.to_lowercase(),
        draft.username,
        draft.port,
        draft.auth_method,
        draft.key_path,
        draft.identity_id,
        draft.open_ssh
    ])
}
impl Store {
    pub fn connection_order(&self) -> Result<Vec<String>, String> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        let mut stmt = db
            .prepare("SELECT server_id FROM connection_order ORDER BY position, server_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn set_connection_order(&self, ids: &[String]) -> Result<(), String> {
        if ids.len() > 10000
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err("Connection order must contain at most 10,000 unique connections".into());
        }
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM connection_order", [])
            .map_err(|e| e.to_string())?;
        for (position, id) in ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO connection_order(server_id,position) VALUES(?1,?2)",
                params![id, position as i64],
            )
            .map_err(|_| "A connection no longer exists; the order was not changed".to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn import_connection(
        &self,
        draft: &ServerDraft,
        source: &str,
        alias: &str,
        update: bool,
    ) -> Result<ImportedConnection, String> {
        let _exclusive = self.import_lock.lock().map_err(|e| e.to_string())?;
        if draft.id.is_some()
            || [&draft.password, &draft.key_passphrase, &draft.sudo_password]
                .iter()
                .any(|v| v.as_ref().is_some_and(|s| !s.is_empty()))
            || draft.password_reference.is_some()
        {
            return Err("Config imports cannot contain credentials or arbitrary IDs".into());
        }
        let key = source_key(source, alias, draft)?;
        let existing: Option<String> = self
            .connection
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT server_id FROM import_origins WHERE source_key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = existing {
            let previous = self.get_server(&id)?;
            if !update {
                return Ok(ImportedConnection {
                    server: previous,
                    created: false,
                    updated: false,
                    reconnect: false,
                });
            }
            let mut edited = draft.clone();
            edited.id = Some(id.clone());
            // Explicit reconciliation changes routing/auth only; keep personal organization.
            edited.name = previous.name.clone();
            edited.group_name = previous.group_name.clone();
            edited.tags = previous.tags.clone();
            edited.notes = previous.notes.clone();
            edited.favorite = previous.favorite;
            // A config file cannot supply a password provider. Keep an existing
            // provider while the connection still uses password authentication.
            edited.password_reference = if edited.auth_method == AuthMethod::Password {
                previous.password_reference.clone()
            } else {
                None
            };
            edited.password = None;
            edited.key_passphrase = None;
            edited.sudo_password = None;
            let saved = self.save_server(&edited)?;
            self.connection
                .lock()
                .map_err(|e| e.to_string())?
                .execute(
                    "UPDATE import_origins SET snapshot_json=?1 WHERE source_key=?2",
                    params![fingerprint(draft).to_string(), key],
                )
                .map_err(|e| e.to_string())?;
            let reconnect = saved.auth_method == AuthMethod::OpenSsh
                || crate::ssh::profile_key(&previous) != crate::ssh::profile_key(&saved);
            return Ok(ImportedConnection {
                server: saved,
                created: false,
                updated: true,
                reconnect,
            });
        }
        if update {
            return Err("This imported connection no longer exists. Reload the configuration before updating.".into());
        }
        // Adopt an identical existing entry instead of duplicating repeated imports.
        let matching = self.list_servers()?.into_iter().find(|p| {
            serde_json::json!([
                p.host.to_lowercase(),
                p.username,
                p.port,
                p.auth_method,
                p.key_path,
                p.identity_id,
                p.open_ssh
            ]) == fingerprint(draft)
        });
        let created = matching.is_none();
        let saved = if let Some(profile) = matching {
            profile
        } else {
            self.save_server(draft)?
        };
        self.connection
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT INTO import_origins(source_key,server_id,snapshot_json) VALUES(?1,?2,?3)",
                params![key, saved.id, fingerprint(draft).to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(ImportedConnection {
            server: saved,
            created,
            updated: false,
            reconnect: false,
        })
    }

    pub fn inspect_import_source(
        &self,
        source: &str,
        aliases: &[String],
    ) -> Result<ImportInspection, String> {
        if aliases.len() > 10000 {
            return Err("Too many aliases".into());
        }
        let path = source_path(source)?;
        let aliases: std::collections::HashSet<_> = aliases.iter().collect();
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        let mut statement = db.prepare("SELECT o.source_key,o.server_id,s.name,s.username FROM import_origins o JOIN servers s ON s.id=o.server_id ORDER BY o.source_key").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut existing = std::collections::BTreeSet::new();
        let mut missing = std::collections::BTreeSet::new();
        let mut origins = Vec::new();
        for row in rows {
            let (key, server_id, name, username) = row.map_err(|e| e.to_string())?;
            if let Ok((origin, alias, linked)) =
                serde_json::from_str::<(String, String, bool)>(&key)
            {
                if origin != path {
                    continue;
                }
                if aliases.contains(&alias) {
                    existing.insert(alias.clone());
                    origins.push(ImportOrigin {
                        alias,
                        linked,
                        server_id,
                        name,
                        username,
                    });
                } else {
                    missing.insert(alias);
                }
            }
        }
        Ok(ImportInspection {
            existing: existing.into_iter().collect(),
            missing: missing.into_iter().collect(),
            origins,
        })
    }
    pub fn bulk_metadata(
        &self,
        ids: &[String],
        group: Option<String>,
        tags: Option<Vec<String>>,
        favorite: Option<bool>,
    ) -> Result<(), String> {
        if ids.is_empty() || ids.len() > 10000 {
            return Err("Select between 1 and 10,000 connections".into());
        }
        if group.as_ref().is_some_and(|s| s.len() > 1024)
            || tags
                .as_ref()
                .is_some_and(|v| v.len() > 100 || v.iter().any(|s| s.len() > 256))
        {
            return Err("Group or tags are too long".into());
        }
        let group = group
            .map(|value| {
                if value.trim().is_empty() {
                    Ok(String::new())
                } else {
                    crate::connection_folders::normalize_path(&value)
                }
            })
            .transpose()?;
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        if let Some(group) = group.as_ref().filter(|value| !value.is_empty()) {
            crate::connection_folders::ensure_folders(&tx, group)?;
        }
        for id in ids {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM servers WHERE id=?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                return Err("A selected connection no longer exists; nothing was changed".into());
            }
            if let Some(group) = &group {
                tx.execute(
                    "UPDATE servers SET group_name=NULLIF(trim(?1),''),updated_at=?2 WHERE id=?3",
                    params![group, chrono::Utc::now().to_rfc3339(), id],
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(tags) = &tags {
                let tags: std::collections::BTreeSet<_> = tags
                    .iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                tx.execute(
                    "UPDATE servers SET tags_json=?1,updated_at=?2 WHERE id=?3",
                    params![
                        serde_json::to_string(&tags).map_err(|e| e.to_string())?,
                        chrono::Utc::now().to_rfc3339(),
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(favorite) = favorite {
                tx.execute(
                    "UPDATE servers SET favorite=?1,updated_at=?2 WHERE id=?3",
                    params![favorite, chrono::Utc::now().to_rfc3339(), id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
#[tauri::command(async)]
pub fn inspect_import_source(
    state: State<'_, AppState>,
    source: String,
    aliases: Vec<String>,
) -> Result<ImportInspection, AppError> {
    Ok(state.store.inspect_import_source(&source, &aliases)?)
}

#[tauri::command(async)]
pub fn import_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: ServerDraft,
    source: String,
    alias: String,
    update_existing: bool,
) -> Result<serde_json::Value, AppError> {
    let imported = state
        .store
        .import_connection(&draft, &source, &alias, update_existing)?;
    if imported.reconnect {
        crate::close_server_activity(
            &state,
            &crate::affected_server_ids(&state.store, &imported.server.id)?,
        )?;
    }
    let _ = app.emit("library-changed", ());
    Ok(
        serde_json::json!({"server":imported.server,"created":imported.created,"updated":imported.updated}),
    )
}
#[tauri::command(async)]
pub fn bulk_connection_metadata(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    group: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
) -> Result<(), AppError> {
    state.store.bulk_metadata(&ids, group, tags, favorite)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn set_connection_order(
    app: AppHandle,
    state: State<'_, AppState>,
    server_ids: Vec<String>,
) -> Result<(), AppError> {
    state.store.set_connection_order(&server_ids)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_order_is_atomic_persistent_and_cleans_up_deleted_connections() {
        let dir = std::env::temp_dir().join(format!("ternway-order-{}", uuid::Uuid::new_v4()));
        let path = dir.join("db");
        let vault = dir.join("vault");
        let store = Store::open(&path, &vault).unwrap();
        let draft: ServerDraft = serde_json::from_value(
            serde_json::json!({"name":"qa","host":"first","username":"qa","port":22}),
        )
        .unwrap();
        let a = store.save_server(&draft).unwrap();
        let b = store.save_server(&draft).unwrap();
        let order = vec![b.id.clone(), a.id.clone()];
        store.set_connection_order(&order).unwrap();
        assert!(store
            .set_connection_order(&[a.id.clone(), "missing".into()])
            .is_err());
        assert!(store
            .set_connection_order(&[a.id.clone(), a.id.clone()])
            .is_err());
        assert_eq!(store.connection_order().unwrap(), order);
        drop(store);
        let store = Store::open(&path, &vault).unwrap();
        assert_eq!(store.connection_order().unwrap(), order);
        store.delete_server(&b.id).unwrap();
        assert_eq!(store.connection_order().unwrap(), vec![a.id]);
        store.set_connection_order(&[]).unwrap();
        assert!(store.connection_order().unwrap().is_empty());
        assert!(!vault.exists());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn repeated_import_reconciles_without_duplicate_or_personal_metadata_loss() {
        let dir = std::env::temp_dir().join(format!("ternway-import-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let mut draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa","host":"first","username":"qa","port":22,"groupName":"Personal"})).unwrap();
        let first_import = store
            .import_connection(&draft, "/tmp/config", "qa", false)
            .unwrap();
        assert!(first_import.created);
        let first = first_import.server;
        assert!(
            !store
                .import_connection(&draft, "/tmp/config", "qa", false)
                .unwrap()
                .created
        );
        draft.host = "second".into();
        draft.group_name = Some("Imported".into());
        assert_eq!(
            store
                .import_connection(&draft, "/tmp/config", "qa", false)
                .unwrap()
                .server
                .host,
            "first"
        );
        let updated = store
            .import_connection(&draft, "/tmp/config", "qa", true)
            .unwrap()
            .server;
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.host, "second");
        assert_eq!(updated.group_name.as_deref(), Some("Personal"));
        assert_eq!(store.list_servers().unwrap().len(), 1);
        assert!(store
            .bulk_metadata(
                &[first.id.clone(), "missing".into()],
                Some("wrong".into()),
                None,
                None
            )
            .is_err());
        assert_eq!(
            store.get_server(&first.id).unwrap().group_name.as_deref(),
            Some("Personal")
        );
        store
            .bulk_metadata(
                &[first.id.clone()],
                Some("Work".into()),
                Some(vec!["api".into(), "api".into()]),
                Some(true),
            )
            .unwrap();
        let saved = store.get_server(&first.id).unwrap();
        assert_eq!(saved.tags, vec!["api"]);
        assert!(saved.favorite);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn import_fixture() -> (std::path::PathBuf, Store, std::path::PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("ternway-import-refresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("ssh-config");
        std::fs::write(&source, "Host lab\n HostName first.example\n User qa\n").unwrap();
        let store = Store::open(&directory.join("db"), &directory.join("vault")).unwrap();
        (directory, store, source)
    }

    #[test]
    fn import_inspection_distinguishes_connection_types_and_canonical_sources() {
        let (directory, store, source) = import_fixture();
        let managed: ServerDraft = serde_json::from_value(serde_json::json!({"name":"Copied lab","host":"first.example","username":"qa","port":22})).unwrap();
        let linked: ServerDraft = serde_json::from_value(serde_json::json!({"name":"Linked lab","host":"lab","username":"","port":22,"authMethod":"openSsh","openSsh":{"alias":"lab","configPath":source}})).unwrap();
        let copied = store
            .import_connection(&managed, source.to_str().unwrap(), "lab", false)
            .unwrap();
        let live = store
            .import_connection(&linked, source.to_str().unwrap(), "lab", false)
            .unwrap();
        assert_ne!(copied.server.id, live.server.id);
        let alias_path = directory.join("config-link");
        std::os::unix::fs::symlink(&source, &alias_path).unwrap();
        let preview = store
            .inspect_import_source(alias_path.to_str().unwrap(), &["lab".into()])
            .unwrap();
        assert_eq!(preview.existing, ["lab"]);
        assert!(preview.missing.is_empty());
        assert_eq!(preview.origins.len(), 2);
        assert!(preview
            .origins
            .iter()
            .any(|entry| !entry.linked && entry.server_id == copied.server.id));
        assert!(preview
            .origins
            .iter()
            .any(|entry| entry.linked && entry.server_id == live.server.id));
        assert_eq!(
            store
                .inspect_import_source(source.to_str().unwrap(), &[])
                .unwrap()
                .missing,
            ["lab"]
        );
        assert!(store
            .inspect_import_source(
                directory.join("other-config").to_str().unwrap(),
                &["lab".into()]
            )
            .unwrap()
            .origins
            .is_empty());
        store.delete_server(&copied.server.id).unwrap();
        store.delete_server(&live.server.id).unwrap();
        assert!(store
            .inspect_import_source(source.to_str().unwrap(), &["lab".into()])
            .unwrap()
            .origins
            .is_empty());
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refreshed_import_updates_config_fields_and_preserves_personal_data_and_password_provider() {
        let (directory, store, source) = import_fixture();
        let mut draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"lab","host":"first.example","username":"qa","port":22,"groupName":""})).unwrap();
        let first = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", false)
            .unwrap();
        assert!(first.created);
        assert!(
            first.server.group_name.is_none(),
            "imports belong to the permanent default folder"
        );
        assert!(store.connection_folders().unwrap().is_empty());
        let mut personal = draft.clone();
        personal.id = Some(first.server.id.clone());
        personal.name = "My production host".into();
        personal.group_name = Some("Work/Production".into());
        personal.tags = vec!["important".into()];
        personal.notes = "Keep these notes".into();
        personal.favorite = true;
        personal.password_reference = Some(crate::secret_provider::PasswordReference {
            provider: crate::secret_provider::Provider::OnePassword,
            reference: "op://Work/lab/password".into(),
        });
        store.save_server(&personal).unwrap();
        std::fs::write(
            &source,
            "Host lab\n HostName second.example\n User deploy\n Port 2222\n",
        )
        .unwrap();
        let entries = crate::ssh_config::read(&source).unwrap();
        draft.host = entries[0].host.clone().unwrap();
        draft.username = entries[0].username.clone().unwrap();
        draft.port = entries[0].port.unwrap() as u32;
        draft.group_name = Some("Unwanted new folder".into());
        let refreshed = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", true)
            .unwrap();
        assert!(!refreshed.created);
        assert!(refreshed.updated && refreshed.reconnect);
        assert_eq!(refreshed.server.id, first.server.id);
        assert_eq!(refreshed.server.host, "second.example");
        assert_eq!(refreshed.server.username, "deploy");
        assert_eq!(refreshed.server.port, 2222);
        assert_eq!(refreshed.server.name, personal.name);
        assert_eq!(refreshed.server.group_name, personal.group_name);
        assert_eq!(refreshed.server.tags, personal.tags);
        assert_eq!(refreshed.server.notes, personal.notes);
        assert_eq!(refreshed.server.favorite, personal.favorite);
        assert_eq!(
            refreshed.server.password_reference,
            personal.password_reference
        );
        assert!(!directory.join("vault").exists());
        // A changed key/auth directive is applied too; a password provider must
        // not remain attached after switching to key authentication.
        draft.auth_method = AuthMethod::PrivateKey;
        draft.key_path = Some(directory.join("new-key").to_string_lossy().into_owned());
        let changed_key = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", true)
            .unwrap();
        assert_eq!(changed_key.server.key_path, draft.key_path);
        assert!(changed_key.server.password_reference.is_none());
        assert_eq!(store.list_servers().unwrap().len(), 1);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explicit_linked_refresh_invalidates_shared_transport_even_when_alias_is_unchanged() {
        let (directory, store, source) = import_fixture();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"lab","host":"lab","username":"","port":22,"authMethod":"openSsh","openSsh":{"alias":"lab","configPath":source},"groupName":""})).unwrap();
        let first = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", false)
            .unwrap();
        let kept = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", false)
            .unwrap();
        assert!(!kept.created && !kept.updated && !kept.reconnect);
        std::fs::write(
            &source,
            "Host lab\n HostName new.example\n User deploy\n Port 2222\n",
        )
        .unwrap();
        let refreshed = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", true)
            .unwrap();
        assert_eq!(refreshed.server.id, first.server.id);
        assert!(refreshed.updated && refreshed.reconnect);
        assert_eq!(store.list_servers().unwrap().len(), 1);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stale_update_does_not_recreate_a_deleted_import() {
        let (directory, store, source) = import_fixture();
        let draft: ServerDraft = serde_json::from_value(
            serde_json::json!({"name":"lab","host":"first.example","username":"qa","port":22}),
        )
        .unwrap();
        let first = store
            .import_connection(&draft, source.to_str().unwrap(), "lab", false)
            .unwrap();
        store.delete_server(&first.server.id).unwrap();
        assert!(store
            .import_connection(&draft, source.to_str().unwrap(), "lab", true)
            .unwrap_err()
            .contains("no longer exists"));
        assert!(store.list_servers().unwrap().is_empty());
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
