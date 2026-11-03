//! Accounts, tokens, and the Bearer extractor shared by every token-authenticated
//! endpoint (`/me`, `/auth/logout`, `/admin/*`).

use std::sync::Arc;

use argon2::password_hash::{rand_core::OsRng, SaltString};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db::{self};
use crate::{error, lock_db, AppState};

/// Role ordering: viewer < editor < creator < admin.
pub fn rank(role: &str) -> u8 {
    match role {
        "editor" => 1,
        "creator" => 2,
        "admin" => 3,
        _ => 0,
    }
}

pub fn is_valid_role(role: &str) -> bool {
    matches!(role, "viewer" | "editor" | "creator" | "admin")
}

pub fn password_ok(password: &str) -> bool {
    password.chars().count() >= 8
}

/// Display names derived from the account email, as the desktop client's
/// profile view expects: username and fullName are the email's local part.
pub fn display_names(email: &str) -> (String, String) {
    let local = email.split('@').next().unwrap_or(email).to_string();
    (local.clone(), local)
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("Password hashing failed: {e}"))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored).ok().and_then(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .ok()
    }).is_some()
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Issues a 32-hex-char bearer token; only its SHA-256 hash is stored.
pub fn issue_token(state: &AppState, user_id: i64) -> Result<String, String> {
    let token = random_hex(16);
    let conn = lock_db(state);
    db::insert_token(&conn, &token_hash(&token), user_id)
        .map_err(|_| "Token storage failed".to_string())?;
    Ok(token)
}

fn admin_principal(token_hash: String) -> AuthUser {
    AuthUser {
        user_id: 0,
        token_hash,
        email: "admin".to_string(),
        role: "admin".to_string(),
        grants: None,
    }
}

/// Resolves a raw token to its principal. In enforced mode user 0 (the
/// open-mode admin principal) is deliberately rejected.
pub fn token_principal(state: &AppState, token: &str) -> Option<AuthUser> {
    let hash = token_hash(token);
    let conn = lock_db(state);
    let user_id = db::token_user_id(&conn, &hash).ok()??;
    if user_id == 0 {
        if state.config.require_auth {
            return None;
        }
        return Some(admin_principal(hash));
    }
    let user = db::find_user_by_id(&conn, user_id).ok()??;
    Some(AuthUser {
        user_id: user.id,
        token_hash: hash,
        email: user.email,
        role: user.role,
        grants: db::parse_grants(user.workspace_grants.as_deref()),
    })
}

/// Every authenticated endpoint's principal. Missing or invalid tokens are a
/// 401 with a JSON body in both modes.
pub struct AuthUser {
    pub user_id: i64,
    pub token_hash: String,
    pub email: String,
    pub role: String,
    pub grants: Option<Vec<String>>,
}

impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let invalid = || error(StatusCode::UNAUTHORIZED, "Invalid or missing token");
        let token = bearer_token(parts).ok_or_else(invalid)?;
        token_principal(state, &token).ok_or_else(invalid)
    }
}

fn bearer_token(parts: &Parts) -> Option<String> {
    let value = parts
        .headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .trim();
    let (scheme, rest) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
        Some(rest.trim().to_string())
    } else {
        None
    }
}

fn parse_body(body: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice(body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Body must be valid JSON"))
}

pub fn email_of(value: &Value) -> Option<&str> {
    value
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|email| !email.is_empty() && email.contains('@'))
}

pub fn password_of(value: &Value) -> Option<&str> {
    value.get("password").and_then(Value::as_str)
}

pub async fn register(State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    if !state.config.require_auth {
        return error(StatusCode::FORBIDDEN, "Registration is currently disabled");
    }
    let allow_registration = {
        let conn = lock_db(&state);
        db::allow_registration(&conn).unwrap_or(true)
    };
    if !allow_registration {
        return error(StatusCode::FORBIDDEN, "Registration is currently disabled");
    }
    let Some(email) = email_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Enter a valid email address");
    };
    let Some(password) = password_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
    };
    if !password_ok(password) {
        return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
    }
    let password_hash = match hash_password(password) {
        Ok(hash) => hash,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    enum Created {
        Yes(i64, String, String),
        Conflict,
        Failed,
    }

    let outcome = {
        let conn = lock_db(&state);
        let first_user = db::count_users(&conn).unwrap_or(1) == 0;
        let role = if first_user { "admin" } else { "viewer" };
        match db::insert_user(&conn, email, &password_hash, role, None, &db::now_iso()) {
            Ok(id) => Created::Yes(id, email.to_string(), role.to_string()),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Created::Conflict
            }
            Err(_) => Created::Failed,
        }
    };

    match outcome {
        Created::Yes(id, email, role) => {
            let (username, full_name) = display_names(&email);
            crate::json(
                StatusCode::CREATED,
                &json!({
                    "user": {
                        "id": id,
                        "username": username,
                        "fullName": full_name,
                        "email": email,
                        "role": role
                    }
                }),
            )
        }
        Created::Conflict => {
            error(StatusCode::CONFLICT, "An account with this email already exists")
        }
        Created::Failed => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the account"),
    }
}

pub async fn login(State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let user = match email_of(&value) {
        Some(email) => {
            let conn = lock_db(&state);
            db::find_user_by_email(&conn, email).ok().flatten()
        }
        None => None,
    };
    let Some(user) = user else {
        return error(StatusCode::UNAUTHORIZED, "Wrong email or password");
    };
    if !verify_password(password_of(&value).unwrap_or(""), &user.password_hash) {
        return error(StatusCode::UNAUTHORIZED, "Wrong email or password");
    }
    let token = match issue_token(&state, user.id) {
        Ok(token) => token,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    let (username, full_name) = display_names(&user.email);
    crate::json(
        StatusCode::OK,
        &json!({
            "token": token,
            "user": {
                "id": user.id,
                "username": username,
                "fullName": full_name,
                "email": user.email,
                "role": user.role
            }
        }),
    )
}

pub async fn logout(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    {
        let conn = lock_db(&state);
        let _ = db::delete_token(&conn, &user.token_hash);
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn me(user: AuthUser) -> Response {
    let grants = match user.grants {
        Some(list) => json!(list),
        None => Value::Null,
    };
    let (username, full_name) = display_names(&user.email);
    crate::json(
        StatusCode::OK,
        &json!({
            "user": {
                "id": user.user_id,
                "username": username,
                "fullName": full_name,
                "email": user.email,
                "role": user.role,
                "workspace_grants": grants
            }
        }),
    )
}

/// Open-mode admin login. Only valid when REQUIRE_AUTH is false.
pub async fn admin_login(State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    if state.config.require_auth {
        return error(StatusCode::UNAUTHORIZED, "Admin login requires REQUIRE_AUTH to be disabled");
    }
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let Some(password) = password_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Body must include a password");
    };
    let expected = state.config.admin_password.clone().unwrap_or_default();
    if expected.is_empty() || password != expected {
        return error(StatusCode::UNAUTHORIZED, "Invalid admin password");
    }
    let token = match issue_token(&state, 0) {
        Ok(token) => token,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    crate::json(
        StatusCode::OK,
        &json!({
            "token": token,
            "user": { "id": 0, "email": "admin", "role": "admin" }
        }),
    )
}