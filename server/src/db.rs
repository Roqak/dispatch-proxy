//! SQLite storage: idempotent migrations plus every query the server needs.
//! The single connection lives behind a std Mutex owned by `AppState`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub struct UserRecord {
    pub id: i64,
    pub email: String,
    pub password_hash: String,
    pub role: String,
    /// Raw JSON text of granted workspace IDs; None = all workspaces.
    pub workspace_grants: Option<String>,
    pub created_at: String,
}

pub struct AuditRow {
    pub ts: String,
    pub user_id: Option<i64>,
    pub email: Option<String>,
    pub action: String,
    pub method: String,
    pub path: String,
    pub status: i64,
}

pub fn open(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL"); // best effort; fallback to journal is fine
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Couldn't set the SQLite busy timeout: {e}"))?;
    migrate(&conn).map_err(|e| format!("Couldn't initialize {path}: {e}"))?;
    Ok(conn)
}

/// Migrations are idempotent: CREATE TABLE IF NOT EXISTS at boot, nothing else.
fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            workspace_grants TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        -- Where each collection/environment uid lives, learned from every
        -- per-workspace list/create/delete that the proxy sees.
        CREATE TABLE IF NOT EXISTS collections_map (
            uid TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS environments_map (
            uid TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            user_id INTEGER,
            email TEXT,
            action TEXT NOT NULL,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            status INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_registration', '1');
    "#)?;
    Ok(())
}

/// RFC 3339 UTC timestamp for the current moment, e.g. "2026-11-03T20:42:07.123Z".
pub fn now_iso() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
        format!("{:03}", now.subsec_millis())
    )
}

/// Days since 1970-01-01 → (year, month, day); Hinnant's civil-from-days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Grants come back as a JSON array of workspace IDs, or null for "all workspaces".
pub fn parse_grants(raw: Option<&str>) -> Option<Vec<String>> {
    raw.and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
}

pub fn grants_value(user: &UserRecord) -> Value {
    match parse_grants(user.workspace_grants.as_deref()) {
        Some(list) => json!(list),
        None => Value::Null,
    }
}

const USER_COLS: &str = "id, email, password_hash, role, workspace_grants, created_at";

fn user_from_row(row: &rusqlite::Row) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        id: row.get(0)?,
        email: row.get(1)?,
        password_hash: row.get(2)?,
        role: row.get(3)?,
        workspace_grants: row.get(4)?,
        created_at: row.get(5)?,
    })
}

impl UserRecord {
    fn public(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "role": self.role,
            "workspace_grants": grants_value(self),
            "created_at": self.created_at,
        })
    }
}

pub fn user_json(user: &UserRecord) -> Value {
    user.public()
}

pub fn count_users(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
}

pub fn find_user_by_email(conn: &Connection, email: &str) -> Result<Option<UserRecord>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE email = ?1 COLLATE NOCASE"),
        params![email],
        user_from_row,
    )
    .optional()
}

pub fn find_user_by_id(conn: &Connection, id: i64) -> Result<Option<UserRecord>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE id = ?1"),
        params![id],
        user_from_row,
    )
    .optional()
}

pub fn insert_user(
    conn: &Connection,
    email: &str,
    password_hash: &str,
    role: &str,
    workspace_grants: Option<&str>,
    created_at: &str,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO users (email, password_hash, role, workspace_grants, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![email, password_hash, role, workspace_grants, created_at],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_users(conn: &Connection) -> Result<Vec<UserRecord>, rusqlite::Error> {
    let mut stmt =
        conn.prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY id"))?;
    let rows = stmt
        .query_map([], user_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Applies any subset of role / workspace_grants / password (raw PHC string) to a user;
/// `None` means "leave the field untouched". Returns false when the user doesn't exist.
pub fn update_user(
    conn: &Connection,
    id: i64,
    role: Option<&str>,
    grants: Option<Option<String>>,
    password_hash: Option<&str>,
) -> Result<bool, rusqlite::Error> {
    let mut set: Vec<&'static str> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    if let Some(role) = role {
        set.push("role = ?");
        args.push(role.to_string());
    }
    if let Some(grants) = grants {
        set.push("workspace_grants = ?");
        args.push(grants.unwrap_or_default());
    }
    if let Some(hash) = password_hash {
        set.push("password_hash = ?");
        args.push(hash.to_string());
    }
    if set.is_empty() {
        return find_user_by_id(conn, id).map(|u| u.is_some());
    }
    let sql = format!("UPDATE users SET {} WHERE id = ?", set.join(", "));
    args.push(id.to_string());
    let changed = conn.execute(&sql, rusqlite::params_from_iter(args))?;
    Ok(changed > 0)
}

/// Deletes a user and their tokens; returns false when the user doesn't exist.
pub fn delete_user(conn: &Connection, id: i64) -> Result<bool, rusqlite::Error> {
    let deleted = conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    if deleted > 0 {
        conn.execute("DELETE FROM tokens WHERE user_id = ?1", params![id])?;
    }
    Ok(deleted > 0)
}

pub fn insert_token(conn: &Connection, token_hash: &str, user_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)",
        params![token_hash, user_id, now_iso()],
    )?;
    Ok(())
}

pub fn delete_token(conn: &Connection, token_hash: &str) -> Result<bool, rusqlite::Error> {
    let n = conn.execute("DELETE FROM tokens WHERE token_hash = ?1", params![token_hash])?;
    Ok(n > 0)
}

/// Dangling tokens (e.g. of a deleted user) are treated as invalid and removed.
pub fn token_user_id(conn: &Connection, token_hash: &str) -> Result<Option<i64>, rusqlite::Error> {
    let user_id: Option<i64> = conn
        .query_row("SELECT user_id FROM tokens WHERE token_hash = ?1", params![token_hash], |r| r.get(0))
        .optional()?;
    if let Some(id) = user_id {
        if id != 0 && find_user_by_id(conn, id)?.is_none() {
            delete_token(conn, token_hash)?;
            return Ok(None);
        }
    }
    Ok(user_id)
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn allow_registration(conn: &Connection) -> Result<bool, rusqlite::Error> {
    Ok(get_setting(conn, "allow_registration")?
        .map(|v| v == "1")
        .unwrap_or(true))
}

/// Remembers uid → workspace rows from a per-workspace list response (an
/// array) or a create response (a single object). `table` is always one of
/// the two fixed map tables from code, never user input. Best effort: rows
/// that can't be attributed (no uid field) are skipped.
pub fn remember_entries(
    conn: &Connection,
    table: &str,
    workspace_id: &str,
    entries: &Value,
) -> Result<(), rusqlite::Error> {
    let sql = format!(
        "INSERT INTO {table} (uid, workspace_id, name, updated_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(uid) DO UPDATE SET workspace_id = excluded.workspace_id, \
         name = excluded.name, updated_at = excluded.updated_at"
    );
    let objects: Vec<&Value> = match entries {
        Value::Array(items) => items.iter().collect(),
        obj if obj.is_object() => vec![entries],
        _ => vec![],
    };
    for entry in objects {
        let uid = entry
            .get("uid")
            .and_then(Value::as_str)
            .or_else(|| entry.get("id").and_then(Value::as_str));
        let Some(uid) = uid else { continue };
        let name = entry.get("name").and_then(Value::as_str);
        let updated = entry.get("updatedAt").and_then(Value::as_str);
        let _ = conn.execute(&sql, params![uid, workspace_id, name, updated]);
    }
    Ok(())
}

/// Forgets a uid's mapping after a successful upstream delete.
pub fn forget_entry(conn: &Connection, table: &str, uid: &str) -> Result<(), rusqlite::Error> {
    conn.execute(&format!("DELETE FROM {table} WHERE uid = ?1"), params![uid])?;
    Ok(())
}

/// The owning workspace of a collection/environment uid, if cached.
pub fn mapped_workspace(conn: &Connection, table: &str, uid: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT workspace_id FROM {table} WHERE uid = ?1"),
        params![uid],
        |row| row.get(0),
    )
    .optional()
}

pub fn audit_insert(
    conn: &Connection,
    ts: &str,
    user_id: Option<i64>,
    email: Option<&str>,
    method: &str,
    path: &str,
    status: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO audit (ts, user_id, email, action, method, path, status) \
         VALUES (?1, ?2, ?3, 'proxy', ?4, ?5, ?6)",
        params![ts, user_id, email, method, path, status],
    )?;
    Ok(())
}

/// Newest first, limited.
pub fn audit_list(conn: &Connection, limit: i64) -> Result<Vec<AuditRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT ts, user_id, email, action, method, path, status FROM audit \
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(AuditRow {
                ts: row.get(0)?,
                user_id: row.get(1)?,
                email: row.get(2)?,
                action: row.get(3)?,
                method: row.get(4)?,
                path: row.get(5)?,
                status: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn audit_json(rows: &[AuditRow]) -> Value {
    Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "ts": r.ts,
                    "user_id": r.user_id,
                    "email": r.email,
                    "action": r.action,
                    "method": r.method,
                    "path": r.path,
                    "status": r.status,
                })
            })
            .collect(),
    )
}