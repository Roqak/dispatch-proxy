//! Stores Postman API keys, one per profile. On macOS they go in the Keychain;
//! elsewhere in files readable only by the current user.

const LEGACY_FILE: &str = "postman-api-key";

fn profile_file(profile_id: &str) -> String {
    format!("postman-api-key-{}", profile_id)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::profile_file;

    const SERVICE: &str = "app.dispatch.client";

    fn entry(profile_id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, &profile_file(profile_id)).map_err(|e| e.to_string())
    }

    fn legacy_entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, "postman-api-key").map_err(|e| e.to_string())
    }

    pub fn get(_dir: &std::path::Path, profile_id: &str) -> Result<Option<String>, String> {
        match entry(profile_id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Couldn't read the key from Keychain: {e}")),
        }
    }

    pub fn set(_dir: &std::path::Path, profile_id: &str, value: &str) -> Result<(), String> {
        entry(profile_id)?.set_password(value).map_err(|e| format!("Couldn't save the key to Keychain: {e}"))
    }

    pub fn delete(_dir: &std::path::Path, profile_id: &str) -> Result<(), String> {
        match entry(profile_id)?.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn legacy_has(_dir: &std::path::Path) -> bool {
        legacy_entry().is_ok_and(|e| e.get_password().is_ok())
    }

    pub fn legacy_get(_dir: &std::path::Path) -> Result<Option<String>, String> {
        match legacy_entry()?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) | Err(keyring::Error::Ambiguous(_)) => Ok(None),
            Err(e) => Err(format!("Couldn't read the key from Keychain: {e}")),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::profile_file;
    use std::path::{Path, PathBuf};

    fn path(dir: &Path, profile_id: &str) -> PathBuf {
        dir.join(profile_file(profile_id))
    }

    fn legacy_path(dir: &Path) -> PathBuf {
        dir.join(super::LEGACY_FILE)
    }

    pub fn get(dir: &Path, profile_id: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(path(dir, profile_id)) {
            Ok(v) => Ok(Some(v.trim().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(dir: &Path, profile_id: &str, value: &str) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let p = path(dir, profile_id);
        std::fs::write(&p, value).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn delete(dir: &Path, profile_id: &str) -> Result<(), String> {
        match std::fs::remove_file(path(dir, profile_id)) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn legacy_has(dir: &Path) -> bool {
        legacy_path(dir).is_file()
    }

    pub fn legacy_get(dir: &Path) -> Result<Option<String>, String> {
        match std::fs::read_to_string(legacy_path(dir)) {
            Ok(v) => Ok(Some(v.trim().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Copies the pre-profiles single key to a profile. Keeps the legacy copy in
/// place so the old build keeps working if the user rolls back.
pub fn legacy_copy_value(dir: &std::path::Path, profile_id: &str) -> Result<bool, String> {
    match imp::legacy_get(dir)? {
        Some(v) => set(dir, profile_id, v.trim()).map(|_| true),
        None => Ok(false),
    }
}

/// Generic secret slot (e.g. client-certificate passwords), same storage rules
/// as API keys: Keychain on macOS, a 0600 file named `<key>-secret` elsewhere.
pub fn store_get(dir: &std::path::Path, key: &str) -> Result<Option<String>, String> {
    imp::get(dir, &format!("{key}__slot"))
}

pub fn store_set(dir: &std::path::Path, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return imp::delete(dir, &format!("{key}__slot"));
    }
    imp::set(dir, &format!("{key}__slot"), value)
}

pub use imp::{delete, get, legacy_has, set};