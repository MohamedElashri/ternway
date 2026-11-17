use crate::{storage::Store, AppError, AppState};
use rusqlite::{params, Connection};
use std::collections::BTreeSet;
use tauri::{AppHandle, Emitter, State};

pub fn normalize_path(path: &str) -> Result<String, String> {
    if path.len() > 1024 || path.chars().any(char::is_control) {
        return Err("Folder paths must be at most 1,024 bytes without control characters".into());
    }
    let parts: Vec<String> = path
        .split('/')
        .map(|part| part.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    if parts.len() > 16
        || parts
            .iter()
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(
            "Use folder names separated by /, without empty, . or .. names (maximum 16 levels)"
                .into(),
        );
    }
    Ok(parts.join("/"))
}

pub fn ensure_folders(db: &Connection, path: &str) -> Result<(), String> {
    let path = normalize_path(path)?;
    let mut current = String::new();
    for part in path.split('/') {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        db.execute(
            "INSERT OR IGNORE INTO connection_folders(path) VALUES(?1)",
            [&current],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn within(path: &str, parent: &str) -> bool {
    let path = path.to_lowercase();
    let parent = parent.to_lowercase();
    path == parent || path.starts_with(&format!("{parent}/"))
}

pub(crate) fn folders(db: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = db.prepare("SELECT path FROM connection_folders UNION SELECT group_name FROM servers WHERE group_name IS NOT NULL AND trim(group_name) != ''").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut paths = BTreeSet::new();
    for path in rows {
        let path = path.map_err(|e| e.to_string())?;
        let path = normalize_path(&path).unwrap_or(path);
        let mut current = String::new();
        for part in path.split('/') {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(part);
            paths.insert(current.clone());
        }
    }
    Ok(paths.into_iter().collect())
}

impl Store {
    pub fn connection_folders(&self) -> Result<Vec<String>, String> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        folders(&db)
    }

    pub fn create_connection_folder(&self, path: &str) -> Result<(), String> {
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        ensure_folders(&tx, path)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Rename/move a whole subtree, or remove its folders while keeping all connections.
    pub fn change_connection_folder(
        &self,
        source: &str,
        destination: Option<&str>,
    ) -> Result<(), String> {
        if source.is_empty() {
            return match destination {
                Some(name) => self.rename_default_connection_folder(name),
                None => Err("The default folder cannot be deleted".into()),
            };
        }
        let source = normalize_path(source)?;
        let destination = destination.map(normalize_path).transpose()?;
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let existing = folders(&tx)?;
        let saved_order = crate::connection_sidebar::folder_order(&tx)?;
        if !existing
            .iter()
            .any(|path| path.to_lowercase() == source.to_lowercase())
        {
            return Err("Folder no longer exists; nothing was changed".into());
        }
        if let Some(dest) = &destination {
            if within(dest, &source) && dest.to_lowercase() != source.to_lowercase() {
                return Err("A folder cannot be moved inside itself".into());
            }
            if existing
                .iter()
                .any(|path| within(path, dest) && !within(path, &source))
            {
                return Err("Destination folder already exists; choose another name".into());
            }
        }
        let memberships = {
            let mut stmt = tx
                .prepare("SELECT id,group_name FROM servers WHERE group_name IS NOT NULL")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?
        };
        let remap = |path: &str| -> Option<String> {
            destination.as_ref().map(|dest| {
                let suffix = path
                    .split('/')
                    .skip(source.split('/').count())
                    .collect::<Vec<_>>()
                    .join("/");
                if suffix.is_empty() {
                    dest.clone()
                } else {
                    format!("{dest}/{suffix}")
                }
            })
        };
        for (id, path) in memberships {
            let normalized = normalize_path(&path).unwrap_or(path);
            if within(&normalized, &source) {
                tx.execute(
                    "UPDATE servers SET group_name=?1,updated_at=?2 WHERE id=?3",
                    params![remap(&normalized), chrono::Utc::now().to_rfc3339(), id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        // Persist inferred legacy folders as well, so empty folders survive later moves.
        tx.execute("DELETE FROM connection_folders", [])
            .map_err(|e| e.to_string())?;
        for path in existing {
            if within(&path, &source) {
                if let Some(mapped) = remap(&path) {
                    ensure_folders(&tx, &mapped)?;
                }
            } else {
                ensure_folders(&tx, &path)?;
            }
        }
        let order = saved_order.into_iter().filter_map(|path| {
            if within(&path, &source) { remap(&path) } else { Some(path) }
        }).collect::<Vec<_>>();
        crate::connection_sidebar::write_folder_order(&tx, &order)?;
        tx.commit().map_err(|e| e.to_string())
    }
}

#[tauri::command(async)]
pub fn create_connection_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), AppError> {
    state.store.create_connection_folder(&path)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn rename_connection_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    destination: String,
) -> Result<(), AppError> {
    state
        .store
        .change_connection_folder(&path, Some(&destination))?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn delete_connection_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), AppError> {
    state.store.change_connection_folder(&path, None)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ServerDraft;

    #[test]
    fn ordering_and_folders_survive_rename_backup_restore_and_reopen() {
        let dir =
            std::env::temp_dir().join(format!("ternway-organization-{}", uuid::Uuid::new_v4()));
        let path = dir.join("db");
        let vault = dir.join("vault");
        let store = Store::open(&path, &vault).unwrap();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa","host":"localhost","username":"qa","port":22,"groupName":"Work/Production"})).unwrap();
        let a = store.save_server(&draft).unwrap();
        let b = store.save_server(&draft).unwrap();
        let order = vec![b.id.clone(), a.id.clone()];
        store.set_connection_order(&order).unwrap();
        store
            .change_connection_folder("Work", Some("Company"))
            .unwrap();
        store.create_connection_folder("Empty").unwrap();
        let backup = dir.join("backup.json");
        store.export_backup(&backup, false).unwrap();
        use sha2::{Digest, Sha256};
        let checksum = format!("{:x}", Sha256::digest(std::fs::read(&backup).unwrap()));
        store.change_connection_folder("Company", None).unwrap();
        store.set_connection_order(&[]).unwrap();
        store
            .restore_backup(&backup, &checksum, &dir.join("recovery.json"))
            .unwrap();
        drop(store);
        let store = Store::open(&path, &vault).unwrap();
        assert_eq!(store.connection_order().unwrap(), order);
        assert_eq!(
            store.connection_folders().unwrap(),
            vec!["Company", "Company/Production", "Empty"]
        );
        assert_eq!(
            store.get_server(&a.id).unwrap().group_name.as_deref(),
            Some("Company/Production")
        );
        store.delete_server(&a.id).unwrap();
        assert_eq!(store.connection_order().unwrap(), vec![b.id]);
        assert!(!vault.exists());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn folders_persist_rename_subtrees_atomically_and_delete_without_losing_connections() {
        let dir = std::env::temp_dir().join(format!("ternway-folders-{}", uuid::Uuid::new_v4()));
        let path = dir.join("db");
        let vault = dir.join("vault");
        let store = Store::open(&path, &vault).unwrap();
        store
            .create_connection_folder(" Work / Production ")
            .unwrap();
        store.create_connection_folder("Personal").unwrap();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa","host":"localhost","username":"qa","port":22,"groupName":"Work/Production"})).unwrap();
        let server = store.save_server(&draft).unwrap();
        assert!(store
            .change_connection_folder("Work", Some("Work/Inside"))
            .is_err());
        assert!(store
            .change_connection_folder("Work", Some("Personal"))
            .is_err());
        assert!(store.change_connection_folder("missing", None).is_err());
        assert_eq!(
            store.get_server(&server.id).unwrap().group_name.as_deref(),
            Some("Work/Production")
        );
        store
            .change_connection_folder("Work", Some("Company"))
            .unwrap();
        assert_eq!(
            store.get_server(&server.id).unwrap().group_name.as_deref(),
            Some("Company/Production")
        );
        drop(store);
        let store = Store::open(&path, &vault).unwrap();
        assert_eq!(
            store.connection_folders().unwrap(),
            vec!["Company", "Company/Production", "Personal"]
        );
        store.change_connection_folder("Company", None).unwrap();
        assert!(store.get_server(&server.id).unwrap().group_name.is_none());
        assert_eq!(store.list_servers().unwrap().len(), 1);
        assert_eq!(store.connection_folders().unwrap(), vec!["Personal"]);
        assert!(!vault.exists());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn folder_names_are_bounded_and_pattern_characters_are_literal() {
        for path in ["", "A//B", "A/../B", "A/./B", "/A", "A/", "A\nB"] {
            assert!(normalize_path(path).is_err(), "{path}");
        }
        assert_eq!(normalize_path(" A / B  C ").unwrap(), "A/B C");
        assert!(within("A%/Child", "A%"));
        assert!(!within("Anything/Child", "A%"));
        assert!(!within("Workload", "Work"));
    }
}
