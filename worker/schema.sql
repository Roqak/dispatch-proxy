-- dispatch-server on Cloudflare Workers: D1 schema.
-- Mirrors server/src/db.rs::migrate() exactly (CREATE TABLE IF NOT EXISTS;
-- idempotent, safe to re-apply with: npx wrangler d1 execute dispatch-server --remote --file schema.sql
-- or `--local` while running `wrangler dev`).

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