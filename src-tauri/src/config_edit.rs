//! Lossless settings edits: keep comments, unknown keys and included files intact.
use crate::config::{self, ConfigUpdate};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static EDIT_LOCK: Mutex<()> = Mutex::new(());
pub fn revision(text: &str) -> String { format!("{:x}", Sha256::digest(text.as_bytes())) }

pub fn profile_path(base: &Path, profile: Option<&str>) -> Result<PathBuf, String> {
    match profile {
        None => Ok(base.to_path_buf()),
        Some(name) if !base.with_file_name("profiles").is_symlink() && !name.is_empty() && name.len() <= 120 && !name.starts_with('.') && !name.ends_with('~') && !name.contains(['/', '\\']) && !name.chars().any(char::is_control) => Ok(base.with_file_name("profiles").join(name)),
        Some(_) => Err("Choose a profile name without path separators, control characters, or a leading dot".into()),
    }
}

pub fn update_text(text: &str, updates: &[ConfigUpdate]) -> Result<String, String> {
    let mut keys = std::collections::HashSet::new();
    for update in updates {
        if update.key.is_empty() || !update.key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') || !keys.insert(update.key.as_str()) {
            return Err("Invalid or duplicate setting name".into());
        }
        if update.values.iter().any(|value| value.contains(['\n', '\r', '\0'])) {
            return Err("A setting value must fit on one line".into());
        }
    }
    let mut result = String::new();
    // Includes precede local overrides even when both are edited in the same save.
    for update in updates.iter().filter(|update| update.key == "config-file") {
        for value in &update.values { result.push_str(&format!("config-file = {value}\n")); }
    }
    for line in text.lines() {
        if config::parse_line(line).is_some_and(|(key, _)| keys.contains(key.as_str())) { continue; }
        result.push_str(line);
        result.push('\n');
    }
    for update in updates.iter().filter(|update| update.key != "config-file") {
        for value in &update.values {
            result.push_str(&format!("{} = {}\n", update.key, value));
        }
    }
    Ok(result)
}

/// Compare the raw file before replacement so an external editor is never silently overwritten.
pub fn save_at(base: &Path, profile: Option<&str>, expected_revision: &str, updates: &[ConfigUpdate]) -> Result<(), String> {
    let _guard = EDIT_LOCK.lock().map_err(|e| e.to_string())?;
    let path = profile_path(base, profile)?;
    let original = fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if revision(&original) != expected_revision { return Err("The configuration changed outside this form. Reload settings before saving again.".into()); }
    let contents = update_text(&original, updates)?;
    atomic_write(&path, &contents, Some(expected_revision))
}

fn atomic_write(path: &Path, contents: &str, expected: Option<&str>) -> Result<(), String> {
    let parent = path.parent().ok_or("Configuration has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".ternway-settings-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        if let Ok(metadata) = fs::metadata(path) { file.set_permissions(metadata.permissions()).map_err(|e| e.to_string())?; }
        file.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if let Some(expected) = expected {
            if revision(&fs::read_to_string(path).map_err(|e| e.to_string())?) != expected { return Err("Configuration changed while saving; reload and retry".into()); }
        }
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

pub fn create_at(base: &Path, name: &str) -> Result<(), String> {
    let _guard = EDIT_LOCK.lock().map_err(|e| e.to_string())?;
    let path = profile_path(base, Some(name))?;
    fs::create_dir_all(path.parent().ok_or("Profile has no parent")?).map_err(|e| e.to_string())?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|e| format!("Could not create profile: {e}"))?;
    file.write_all(b"# Ternway terminal profile. Inherits the main configuration.\n").map_err(|e| e.to_string())
}
pub fn delete_at(base: &Path, name: &str, expected_revision: &str) -> Result<(), String> {
    let _guard = EDIT_LOCK.lock().map_err(|e| e.to_string())?;
    let path = profile_path(base, Some(name))?;
    if revision(&fs::read_to_string(&path).map_err(|e| e.to_string())?) != expected_revision { return Err("Profile changed outside Settings. Reload before deleting.".into()); }
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn update(key: &str, values: &[&str]) -> ConfigUpdate { ConfigUpdate { key: key.into(), values: values.iter().map(|v| (*v).into()).collect() } }
    #[test]
    fn edits_keep_comments_unknown_keys_and_includes() {
        let original = "# Keep me\nconfig-file = ?ghostty\nfont-size = 12\nunknown-option = x\nfont-size = 14\n";
        let result = update_text(original, &[update("font-size", &["16"]), update("env", &["", "EDITOR=vim", "TOKEN=a=b"])]).unwrap();
        assert_eq!(result, "# Keep me\nconfig-file = ?ghostty\nunknown-option = x\nfont-size = 16\nenv = \nenv = EDITOR=vim\nenv = TOKEN=a=b\n");
        assert!(update_text(original, &[update("font-size", &["12\nenv=BAD"])]).is_err());
        assert!(update_text(original, &[update("a", &["1"]), update("a", &["2"])]).is_err());
    }
    #[test]
    fn changed_includes_precede_existing_and_new_overrides() {
        let result = update_text("# header\nconfig-file = old\nfont-size = 12\n", &[update("font-size", &["16"]), update("config-file", &["new"]) ]).unwrap();
        assert_eq!(result, "config-file = new\n# header\nfont-size = 16\n");
    }
    #[test]
    fn saves_reject_stale_edits_and_profiles_stay_inside_their_directory() {
        let dir = std::env::temp_dir().join(format!("ternway-config-edit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let base = dir.join("config");
        fs::write(&base, "# original\n").unwrap();
        let old = revision("# original\n");
        save_at(&base, None, &old, &[update("font-size", &["16"])]).unwrap();
        assert!(save_at(&base, None, &old, &[update("font-size", &["20"])]).is_err());
        assert!(fs::read_to_string(&base).unwrap().contains("16"));
        for name in ["../config", "/tmp/escape", ".hidden", "a\\b", "a\nb", ""] { assert!(create_at(&base, name).is_err()); }
        create_at(&base, "Work").unwrap();
        assert!(create_at(&base, "Work").is_err());
        let profile = profile_path(&base, Some("Work")).unwrap();
        let rev = revision(&fs::read_to_string(&profile).unwrap());
        delete_at(&base, "Work", &rev).unwrap();
        assert!(!profile.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
