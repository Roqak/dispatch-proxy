//! dispatch-server — the self-hostable backend for the Dispatch desktop app.
//!
//! One shared Postman API key (env), served to multiple users through
//! role-based access control: config.rs reads the environment, db.rs owns the
//! SQLite store, auth.rs the accounts/tokens, proxy.rs the Postman
//! passthrough, and admin.rs the admin API plus the embedded admin panel.

mod admin;
mod auth;
mod config;
mod db;
mod proxy;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{extract::DefaultBodyLimit, Router};
use rusqlite::Connection;
use tower_http::cors::CorsLayer;

use crate::config::Config;

/// How long per-workspace list results stay cached while serving merges for
/// granted principals.
pub const LIST_CACHE_TTL: Duration = Duration::from_secs(60);

pub struct AppState {
    pub db: Mutex<Connection>,
    pub config: Config,
    pub http: reqwest::Client,
    /// Per-workspace list responses seen by the proxy (60s TTL), keyed by
    /// "<base path>:<workspace id>".
    pub list_cache: Mutex<HashMap<String, CachedList>>,
}

/// A cached per-workspace list response and the rate-limit header that came
/// with it.
pub struct CachedList {
    pub at: Instant,
    pub rate: Option<String>,
    pub body: axum::body::Bytes,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("dispatch-server: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env()?;
    if config.postman_api_key.is_none() {
        eprintln!(
            "dispatch-server: POSTMAN_API_KEY is not set — proxying is disabled (auth and the admin API still work)"
        );
    }
    let db = db::open(&config.db_path)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("dispatch-server/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Couldn't build the upstream HTTP client: {e}"))?;
    let state = std::sync::Arc::new(AppState {
        db: Mutex::new(db),
        config,
        http,
        list_cache: Mutex::new(HashMap::new()),
    });

    let addr = state.config.listen_addr.clone();
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Couldn't bind {addr}: {e}"))?;
    let mode = if state.config.require_auth {
        "auth enforced"
    } else {
        "open (no auth)"
    };
    println!("dispatch-server listening on http://{addr} ({mode})");

    axum::serve(listener, router(state))
        .await
        .map_err(|e| format!("Server error: {e}"))
}

pub fn router(state: std::sync::Arc<AppState>) -> Router {
    Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/admin-login", post(auth::admin_login))
        .route("/me", get(auth::me))
        .route("/admin/users", get(admin::users_list).post(admin::users_create))
        .route("/admin/users/{id}", patch(admin::users_update).delete(admin::users_delete))
        .route("/admin/settings", get(admin::settings_get).patch(admin::settings_patch))
        .route("/admin/audit", get(admin::audit_list))
        .route("/admin", get(admin::panel_redirect))
        .route("/admin/", get(admin::panel_index))
        .route("/admin/{*path}", get(admin::panel_file))
        .fallback(proxy::proxy)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(CorsLayer::permissive())
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
}

/// Every error body is JSON: {"error": "..."}.
pub fn error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    json(status, &serde_json::json!({ "error": message.to_string() }))
}

pub fn json(status: StatusCode, body: &serde_json::Value) -> Response {
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

async fn method_not_allowed() -> Response {
    error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
}

/// rusqlite runs behind a std Mutex; a poisoned lock only means a thread
/// panicked mid-query — the connection itself stays usable, so take it.
pub fn lock_db(state: &AppState) -> MutexGuard<'_, Connection> {
    match state.db.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub type ListCacheMap = HashMap<String, CachedList>;

pub fn lock_cache(state: &AppState) -> MutexGuard<'_, ListCacheMap> {
    match state.list_cache.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}