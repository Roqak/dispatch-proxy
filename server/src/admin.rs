//! The admin API (users, settings, audit) and the embedded admin panel.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};

use crate::auth::{self, AuthUser};
use crate::db;
use crate::{error, json, lock_db, AppState};

/// The vanilla-JS admin panel, embedded at build time from server/admin/.
static ADMIN_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/admin");

fn admin_only(user: &AuthUser) -> Result<(), Response> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(error(StatusCode::FORBIDDEN, "Only admins can do this"))
    }
}

// ---------- users -----------------------------------------------------------

pub async fn users_list(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let conn = lock_db(&state);
    match db::list_users(&conn) {
        Ok(users) => json(
            StatusCode::OK,
            &json!(users.iter().map(db::user_json).collect::<Vec<Value>>()),
        ),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't list users"),
    }
}

pub async fn users_create(State(state): State<Arc<AppState>>, user: AuthUser, body: Bytes) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let Some(email) = auth::email_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Enter a valid email address");
    };
    let Some(password) = auth::password_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
    };
    if !auth::password_ok(password) {
        return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
    }
    let role = match value.get("role") {
        None | Some(Value::Null) => "viewer".to_string(),
        Some(Value::String(candidate)) => candidate.clone(),
        Some(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "Role must be one of viewer, editor, creator or admin",
            )
        }
    };
    if !auth::is_valid_role(&role) {
        return error(
            StatusCode::BAD_REQUEST,
            "Role must be one of viewer, editor, creator or admin",
        );
    }
    let grants = match grants_text(value.get("workspace_grants")) {
        Ok(grants) => grants,
        Err(resp) => return resp,
    };
    let password_hash = match auth::hash_password(password) {
        Ok(hash) => hash,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    let created = {
        let conn = lock_db(&state);
        db::insert_user(&conn, email, &password_hash, &role, grants.as_deref(), &db::now_iso())
    };
    match created {
        Ok(id) => match {
            let conn = lock_db(&state);
            db::find_user_by_id(&conn, id)
        } {
            Ok(Some(created)) => json(StatusCode::CREATED, &db::user_json(&created)),
            _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the account"),
        },
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            error(StatusCode::CONFLICT, "An account with this email already exists")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the account"),
    }
}

pub async fn users_update(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id_text): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let Ok(id) = id_text.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "No such user");
    };
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let role = match value.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(candidate)) => {
            if auth::is_valid_role(candidate) {
                Some(candidate)
            } else {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Role must be one of viewer, editor, creator or admin",
                );
            }
        }
        Some(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "Role must be one of viewer, editor, creator or admin",
            )
        }
    };
    let grants = match value.get("workspace_grants") {
        None => None,
        Some(found) => match grants_text(Some(found)) {
            Ok(parsed) => Some(parsed),
            Err(resp) => return resp,
        },
    };
    let password_hash = match value.get("password") {
        None | Some(Value::Null) => None,
        Some(Value::String(password)) => {
            if !auth::password_ok(password) {
                return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
            }
            match auth::hash_password(password) {
                Ok(hash) => Some(Some(hash)),
                Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
            }
        }
        Some(_) => {
            return error(StatusCode::BAD_REQUEST, "Password must be a string")
        }
    };
    let updated = {
        let conn = lock_db(&state);
        match db::update_user(
            &conn,
            id,
            role.map(|r| r.as_str()),
            grants,
            password_hash.as_ref().map(|outer| outer.as_deref()).flatten(),
        ) {
            Ok(true) => db::find_user_by_id(&conn, id),
            Ok(false) => return error(StatusCode::NOT_FOUND, "No such user"),
            Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't update the user"),
        }
    };
    match updated {
        Ok(Some(updated)) => json(StatusCode::OK, &db::user_json(&updated)),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't update the user"),
    }
}

pub async fn users_delete(State(state): State<Arc<AppState>>, user: AuthUser, Path(id_text): Path<String>) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let Ok(id) = id_text.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "No such user");
    };
    if user.user_id == id {
        return error(StatusCode::BAD_REQUEST, "You can't delete your own account");
    }
    let deleted = {
        let conn = lock_db(&state);
        db::delete_user(&conn, id)
    };
    match deleted {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "No such user"),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't delete the user"),
    }
}

// ---------- settings --------------------------------------------------------

pub async fn settings_get(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let allow_registration = {
        let conn = lock_db(&state);
        db::allow_registration(&conn).unwrap_or(true)
    };
    json(StatusCode::OK, &json!({ "allow_registration": allow_registration }))
}

pub async fn settings_patch(State(state): State<Arc<AppState>>, user: AuthUser, body: Bytes) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let Some(allow_registration) = value.get("allow_registration").and_then(Value::as_bool) else {
        return error(StatusCode::BAD_REQUEST, "allow_registration must be true or false");
    };
    let conn = lock_db(&state);
    match db::set_setting(&conn, "allow_registration", if allow_registration { "1" } else { "0" }) {
        Ok(()) => json(StatusCode::OK, &json!({ "allow_registration": allow_registration })),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the setting"),
    }
}

// ---------- audit -----------------------------------------------------------

pub async fn audit_list(State(state): State<Arc<AppState>>, user: AuthUser, RawQuery(query): RawQuery) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let limit = match parse_limit(query.as_deref()) {
        Ok(limit) => limit,
        Err(resp) => return resp,
    };
    let conn = lock_db(&state);
    match db::audit_list(&conn, limit) {
        Ok(rows) => json(StatusCode::OK, &db::audit_json(&rows)),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the audit trail"),
    }
}

/// Newest-first listing capped at 1000 rows (default 100).
fn parse_limit(query: Option<&str>) -> Result<i64, Response> {
    let raw = query.and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "limit" && !value.is_empty()).then_some(value)
        })
    });
    match raw {
        None => Ok(100),
        Some(text) => match text.parse::<i64>() {
            Ok(limit) => Ok(limit.clamp(1, 1000)),
            Err(_) => Err(error(StatusCode::BAD_REQUEST, "limit must be a number")),
        },
    }
}

// ---------- shared bits ------------------------------------------------------

fn parse_body(body: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice(body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Body must be valid JSON"))
}

/// workspace_grants in admin payloads: null (all workspaces) or an array of
/// workspace ID strings; stored as JSON text.
fn grants_text(value: Option<&Value>) -> Result<Option<String>, Response> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(list)) if list.iter().all(Value::is_string) => serde_json::to_string(list)
            .ok()
            .map(Some)
            .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't encode workspace grants")),
        Some(_) => Err(error(
            StatusCode::BAD_REQUEST,
            "workspace_grants must be an array of workspace IDs",
        )),
    }
}

// ---------- embedded admin panel --------------------------------------------

/// GET /admin (no trailing slash) redirects so the panel's relative assets
/// (./styles.css, ./app.js) resolve against /admin/.
pub async fn panel_redirect() -> Response {
    Redirect::to("/admin/").into_response()
}

pub async fn panel_index() -> Response {
    match ADMIN_DIR.get_file("index.html") {
        Some(file) => file_response(file),
        None => error(
            StatusCode::NOT_FOUND,
            "The admin panel (index.html) is not embedded in this binary",
        ),
    }
}

pub async fn panel_file(Path(path): Path<String>) -> Response {
    let relative = path.trim_start_matches('/');
    match ADMIN_DIR.get_file(relative) {
        Some(file) => file_response(file),
        None => error(StatusCode::NOT_FOUND, "No such admin panel file"),
    }
}

fn file_response(file: &'static include_dir::File<'static>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(file.path().to_string_lossy().as_ref()))
        .body(Body::from(axum::body::Bytes::from_static(file.contents())))
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Response construction failed"))
}

fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("");
    match extension {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}