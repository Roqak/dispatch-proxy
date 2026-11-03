//! Collections saved as plain files in a folder (for Git). The page can only
//! touch folders the user picked in the system folder dialog, only .json/.md
//! files, and never outside that folder.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct Folders {
    allowed: Mutex<BTreeSet<PathBuf>>,
    file: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FileEntry {
    /// Relative to the linked folder, with "/" separators.
    pub path: String,
    pub content: String,
}

const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

impl Folders {
    /// Restores the folders picked in earlier sessions.
    pub fn attach(&self, file: PathBuf) {
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(list) = serde_json::from_str::<Vec<PathBuf>>(&text) {
                self.allowed.lock().unwrap_or_else(|p| p.into_inner()).extend(list.into_iter().filter(|p| p.is_dir()));
            }
        }
        *self.file.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
    }

    fn save(&self) {
        let Some(file) = self.file.lock().unwrap_or_else(|p| p.into_inner()).clone() else { return };
        let list: Vec<PathBuf> = self.allowed.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect();
        if let Ok(text) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(file, text);
        }
    }

    /// Called with a folder the user just picked in the dialog.
    pub fn allow(&self, dir: &Path) -> Result<PathBuf, String> {
        let canon = dir.canonicalize().map_err(|e| format!("Couldn't open that folder: {e}"))?;
        if !canon.is_dir() {
            return Err("That isn't a folder.".into());
        }
        self.allowed.lock().unwrap_or_else(|p| p.into_inner()).insert(canon.clone());
        self.save();
        Ok(canon)
    }

    pub fn forget(&self, dir: &str) {
        if let Ok(canon) = Path::new(dir).canonicalize() {
            self.allowed.lock().unwrap_or_else(|p| p.into_inner()).remove(&canon);
            self.save();
        }
    }

    fn root(&self, dir: &str) -> Result<PathBuf, String> {
        let canon = Path::new(dir).canonicalize().map_err(|_| format!("The folder {dir} is missing. Link the collection to a folder again."))?;
        if self.allowed.lock().unwrap_or_else(|p| p.into_inner()).contains(&canon) {
            Ok(canon)
        } else {
            Err("Dispatch can only use folders you picked yourself. Choose the folder again from the collection's menu.".into())
        }
    }

    pub fn read(&self, dir: &str) -> Result<Vec<FileEntry>, String> {
        let root = self.root(dir)?;
        let mut out = Vec::new();
        walk(&root, &root, 0, &mut out)?;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Writes `files`; with `prune`, removes Dispatch's own files (folder.json,
    /// *.request.json) that are no longer part of the collection, and empty folders.
    pub fn write(&self, dir: &str, files: &[FileEntry], prune: bool) -> Result<usize, String> {
        let root = self.root(dir)?;
        if files.len() > MAX_FILES {
            return Err("Too many files for one collection.".into());
        }
        let mut keep = BTreeSet::new();
        let mut changed = 0;
        for f in files {
            let rel = safe_relative(&f.path)?;
            let target = root.join(&rel);
            keep.insert(target.clone());
            if std::fs::read_to_string(&target).ok().as_deref() == Some(f.content.as_str()) {
                continue; // unchanged: keep the file's timestamp (and Git status) quiet
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
            }
            let tmp = target.with_extension("dispatch-tmp");
            std::fs::write(&tmp, &f.content).map_err(|e| format!("Couldn't write {}: {e}", f.path))?;
            std::fs::rename(&tmp, &target).map_err(|e| format!("Couldn't write {}: {e}", f.path))?;
            changed += 1;
        }
        if prune {
            changed += prune_dir(&root, &root, &keep, 0)?;
        }
        Ok(changed)
    }
}

/// Rejects absolute paths, "..", hidden segments and anything but .json/.md.
fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    let ok_ext = matches!(p.extension().and_then(|e| e.to_str()), Some("json") | Some("md"));
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => {
                let s = s.to_str().ok_or("File names must be valid text.")?;
                if s.starts_with('.') || s.is_empty() {
                    return Err(format!("Refusing to write \"{path}\"."));
                }
                out.push(s);
            }
            _ => return Err(format!("Refusing to write \"{path}\".")),
        }
    }
    if !ok_ext || out.as_os_str().is_empty() {
        return Err(format!("Refusing to write \"{path}\"."));
    }
    Ok(out)
}

fn is_ours(name: &str) -> bool {
    name == "folder.json" || name.ends_with(".request.json")
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<FileEntry>) -> Result<(), String> {
    if depth > 16 {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        if ft.is_dir() {
            walk(root, &path, depth + 1, out)?;
        } else if ft.is_file() && (name.ends_with(".json") || name.ends_with(".md")) {
            if out.len() >= MAX_FILES {
                return Err("That folder has too many files to be one collection.".into());
            }
            if e.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            let rel = path.strip_prefix(root).unwrap_or(&path).components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/");
            out.push(FileEntry { path: rel, content });
        }
    }
    Ok(())
}

fn prune_dir(root: &Path, dir: &Path, keep: &BTreeSet<PathBuf>, depth: usize) -> Result<usize, String> {
    if depth > 16 {
        return Ok(0);
    }
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(0) };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            removed += prune_dir(root, &path, keep, depth + 1)?;
            // Only folders that held nothing but our own files end up empty.
            if std::fs::read_dir(&path).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(&path);
            }
        } else if ft.is_file() && is_ours(&name) && !keep.contains(&path) {
            std::fs::remove_file(&path).map_err(|e| format!("Couldn't remove {}: {e}", path.display()))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dispatch-folders-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn f(path: &str, content: &str) -> FileEntry {
        FileEntry { path: path.into(), content: content.into() }
    }

    #[test]
    fn only_picked_folders_and_safe_paths() {
        let d = tmpdir("safe");
        let folders = Folders::default();
        let s = d.to_string_lossy().to_string();
        assert!(folders.write(&s, &[f("collection.json", "{}")], false).unwrap_err().contains("picked yourself"));
        folders.allow(&d).unwrap();
        for bad in ["../x.json", "/etc/x.json", "a/../../x.json", ".git/config.json", "x.sh", "a/.hidden/x.json", ""] {
            assert!(folders.write(&s, &[f(bad, "1")], false).is_err(), "{bad}");
        }
        assert_eq!(folders.write(&s, &[f("collection.json", "{}"), f("Users/folder.json", "{}"), f("Users/get-user.request.json", "{}")], false).unwrap(), 3);
        assert_eq!(folders.write(&s, &[f("collection.json", "{}")], false).unwrap(), 0, "unchanged files aren't rewritten");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn read_and_prune_round_trip() {
        let d = tmpdir("prune");
        let folders = Folders::default();
        folders.allow(&d).unwrap();
        let s = d.to_string_lossy().to_string();
        folders.write(&s, &[f("collection.json", "c"), f("A/folder.json", "a"), f("A/one.request.json", "1"), f("B/two.request.json", "2")], false).unwrap();
        std::fs::write(d.join("README.md"), "docs").unwrap();
        std::fs::write(d.join("B").join("notes.txt"), "keep me").unwrap();
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::write(d.join(".git").join("x.json"), "hidden").unwrap();
        let paths: Vec<String> = folders.read(&s).unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["A/folder.json", "A/one.request.json", "B/two.request.json", "README.md", "collection.json"]);

        // "A" was deleted from the collection; B's request was renamed.
        folders.write(&s, &[f("collection.json", "c2"), f("B/three.request.json", "3")], true).unwrap();
        assert!(!d.join("A").exists(), "empty managed folder removed");
        assert!(!d.join("B/two.request.json").exists());
        assert!(d.join("B/notes.txt").exists(), "files that aren't ours stay");
        assert!(d.join("README.md").exists());
        assert!(d.join(".git/x.json").exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn remembers_picked_folders() {
        let d = tmpdir("remember");
        let store = std::env::temp_dir().join(format!("dispatch-linked-{}.json", std::process::id()));
        let a = Folders::default();
        a.attach(store.clone());
        a.allow(&d).unwrap();
        let b = Folders::default();
        b.attach(store.clone());
        assert!(b.read(&d.to_string_lossy()).is_ok());
        b.forget(&d.to_string_lossy());
        let c = Folders::default();
        c.attach(store.clone());
        assert!(c.read(&d.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(store);
        let _ = std::fs::remove_dir_all(d);
    }
}
