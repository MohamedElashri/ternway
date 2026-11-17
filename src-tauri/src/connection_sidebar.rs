use crate::{
    connection_folders::{ensure_folders, normalize_path},
    storage::Store,
    AppError, AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLibrary {
    servers: Vec<crate::models::ServerProfile>,
    connection_order: Vec<String>,
    connection_folders: Vec<String>,
    connection_folder_order: Vec<String>,
    default_connection_folder: String,
    identities: Vec<crate::identities::Identity>,
}

/// Library edits do not require rescanning SSH config Includes or the key directory.
#[tauri::command(async)]
pub fn get_connection_library(state: State<'_, AppState>) -> Result<ConnectionLibrary, AppError> {
    Ok(ConnectionLibrary {
        servers: state.store.list_servers()?,
        connection_order: state.store.connection_order()?,
        connection_folders: state.store.connection_folders()?,
        connection_folder_order: state.store.connection_folder_order()?,
        default_connection_folder: state.store.default_connection_folder()?,
        identities: state.store.list_identities()?,
    })
}

fn default_name(value: &str) -> Result<String, String> {
    let name = normalize_path(value)?;
    if name.contains('/') || name.len() > 80 {
        return Err("Use a folder name up to 80 bytes, without /".into());
    }
    Ok(name)
}

pub(crate) fn folder_order(db: &Connection) -> Result<Vec<String>, String> {
    let mut statement = db
        .prepare("SELECT path FROM connection_folder_order ORDER BY position,path")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn write_folder_order(db: &Connection, paths: &[String]) -> Result<(), String> {
    if paths.len() > 10000
        || paths
            .iter()
            .map(|path| path.to_lowercase())
            .collect::<HashSet<_>>()
            .len()
            != paths.len()
    {
        return Err("Folder order must contain at most 10,000 unique folders".into());
    }
    db.execute("DELETE FROM connection_folder_order", [])
        .map_err(|e| e.to_string())?;
    for (index, path) in paths.iter().enumerate() {
        db.execute(
            "INSERT INTO connection_folder_order(path,position) VALUES(?1,?2)",
            params![path, index as i64],
        )
        .map_err(|_| "A folder no longer exists; nothing was changed".to_string())?;
    }
    Ok(())
}

impl Store {
    /// Empty/null memberships identify a permanent folder independently of its display name.
    pub fn default_connection_folder(&self) -> Result<String, String> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        let name: Option<String> = db
            .query_row(
                "SELECT value FROM library_preferences WHERE name='default-folder'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(name
            .and_then(|name| default_name(&name).ok())
            .unwrap_or_else(|| "Default".into()))
    }

    pub fn rename_default_connection_folder(&self, name: &str) -> Result<(), String> {
        let name = default_name(name)?;
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        db.execute("INSERT INTO library_preferences(name,value) VALUES('default-folder',?1) ON CONFLICT(name) DO UPDATE SET value=excluded.value", [name]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn connection_folder_order(&self) -> Result<Vec<String>, String> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        folder_order(&db)
    }

    pub fn set_connection_folder_order(&self, paths: &[String]) -> Result<(), String> {
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let existing = crate::connection_folders::folders(&tx)?;
        for path in paths {
            normalize_path(path)?;
            if !existing.contains(path) {
                return Err("A folder no longer exists; nothing was changed".into());
            }
            ensure_folders(&tx, path)?;
        }
        write_folder_order(&tx, paths)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Membership and order move together, so a failed/stale drop leaves both unchanged.
    pub fn reorganize_connection(
        &self,
        id: &str,
        destination: &str,
        order: &[String],
    ) -> Result<(), String> {
        let destination = if destination.trim().is_empty() {
            None
        } else {
            Some(normalize_path(destination)?)
        };
        if order.len() > 10000
            || !order.iter().any(|item| item == id)
            || order.iter().collect::<HashSet<_>>().len() != order.len()
        {
            return Err(
                "Connection order must include the moved connection and contain no duplicates"
                    .into(),
            );
        }
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        if let Some(path) = &destination {
            ensure_folders(&tx, path)?;
        }
        let changed = tx
            .execute(
                "UPDATE servers SET group_name=?1,updated_at=?2 WHERE id=?3",
                params![destination, chrono::Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("The connection no longer exists; nothing was changed".into());
        }
        tx.execute("DELETE FROM connection_order", [])
            .map_err(|e| e.to_string())?;
        for (position, id) in order.iter().enumerate() {
            tx.execute(
                "INSERT INTO connection_order(server_id,position) VALUES(?1,?2)",
                params![id, position as i64],
            )
            .map_err(|_| "A connection no longer exists; nothing was changed".to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}

#[tauri::command(async)]
pub fn reorganize_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    group_name: String,
    server_ids: Vec<String>,
) -> Result<(), AppError> {
    state
        .store
        .reorganize_connection(&server_id, &group_name, &server_ids)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn set_connection_folder_order(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), AppError> {
    state.store.set_connection_folder_order(&paths)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ServerDraft;
    use sha2::{Digest, Sha256};

    fn library() -> (std::path::PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("ternway-sidebar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        (dir, store)
    }

    fn draft(name: &str) -> ServerDraft {
        serde_json::from_value(
            serde_json::json!({"name":name,"host":"localhost","username":"qa","port":22}),
        )
        .unwrap()
    }

    #[test]
    fn default_folder_identity_and_folder_order_survive_rename_delete_backup_and_reopen() {
        let (dir, store) = library();
        let server = store.save_server(&draft("qa")).unwrap();
        assert!(server.group_name.is_none());
        assert_eq!(store.default_connection_folder().unwrap(), "Default");
        store.change_connection_folder("", Some("Home")).unwrap();
        assert!(store
            .change_connection_folder("", None)
            .unwrap_err()
            .contains("cannot be deleted"));
        assert!(store
            .change_connection_folder("", Some("Home/Child"))
            .is_err());
        store.create_connection_folder("Work/Production").unwrap();
        store.create_connection_folder("Personal").unwrap();
        let order = vec!["Personal".into(), "Work".into(), "Work/Production".into()];
        store.set_connection_folder_order(&order).unwrap();
        store
            .reorganize_connection(&server.id, "Work/Production", &[server.id.clone()])
            .unwrap();
        store
            .change_connection_folder("Work", Some("Company"))
            .unwrap();
        assert_eq!(
            store.connection_folder_order().unwrap(),
            vec!["Personal", "Company", "Company/Production"]
        );
        let backup = dir.join("backup.json");
        store.export_backup(&backup, false).unwrap();
        let checksum = format!("{:x}", Sha256::digest(std::fs::read(&backup).unwrap()));
        store.change_connection_folder("Company", None).unwrap();
        assert!(store.list_servers().unwrap()[0].group_name.is_none());
        assert_eq!(store.default_connection_folder().unwrap(), "Home");
        assert_eq!(store.connection_folder_order().unwrap(), vec!["Personal"]);
        store
            .restore_backup(&backup, &checksum, &dir.join("recovery.json"))
            .unwrap();
        drop(store);
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        assert_eq!(store.default_connection_folder().unwrap(), "Home");
        assert_eq!(
            store.connection_folder_order().unwrap(),
            vec!["Personal", "Company", "Company/Production"]
        );
        assert_eq!(
            store.list_servers().unwrap()[0].group_name.as_deref(),
            Some("Company/Production")
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_drops_and_invalid_folder_orders_roll_back_every_change() {
        let (dir, store) = library();
        let a = store.save_server(&draft("a")).unwrap();
        let b = store.save_server(&draft("b")).unwrap();
        let original = vec![a.id.clone(), b.id.clone()];
        store.set_connection_order(&original).unwrap();
        assert!(store
            .reorganize_connection(
                &a.id,
                "Created by failed drop",
                &[a.id.clone(), "missing".into()]
            )
            .is_err());
        assert!(store.connection_folders().unwrap().is_empty());
        assert!(store
            .list_servers()
            .unwrap()
            .iter()
            .all(|server| server.group_name.is_none()));
        assert_eq!(store.connection_order().unwrap(), original);
        store
            .reorganize_connection(&a.id, "Work", &[b.id.clone(), a.id.clone()])
            .unwrap();
        assert_eq!(store.connection_order().unwrap(), vec![b.id, a.id]);
        store.set_connection_folder_order(&["Work".into()]).unwrap();
        for invalid in [
            vec!["missing".into()],
            vec!["".into()],
            vec!["Work".into(), "Work".into()],
        ] {
            assert!(store.set_connection_folder_order(&invalid).is_err());
            assert_eq!(store.connection_folder_order().unwrap(), vec!["Work"]);
        }
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
