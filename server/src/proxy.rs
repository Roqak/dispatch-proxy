//! The Postman proxy: an allowlisted passthrough of the Postman API surface
//! with role checks, workspace scoping for granted users, secret redaction
//! for viewers, and an audit row for every request.

use std::sync::Arc;
use std::time::Instant;

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderName, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::auth::{rank, token_principal};
use crate::db;
use crate::{error, json, lock_cache, lock_db, AppState, CachedList, LIST_CACHE_TTL};

/// Largest request body we accept for a proxied call (collections can be big).
const MAX_PROXY_BODY: usize = 64 * 1024 * 1024;
const RATE_LIMIT_HEADER: HeaderName = HeaderName::from_static("x-ratelimit-remaining-month");

#[derive(Clone, Copy, PartialEq)]
enum Family {
    Workspaces,
    Collections,
    Environments,
    Apis,
    Monitors,
    MockServers,
    Schemas,
    Integrations,
    Scim,
}

/// The documented Postman API surface; everything else is rejected.
fn family_of(path: &str) -> Option<(Family, &str)> {
    const PREFIXES: [(&str, Family); 9] = [
        ("/workspaces", Family::Workspaces),
        ("/collections", Family::Collections),
        ("/environments", Family::Environments),
        ("/apis", Family::Apis),
        ("/monitors", Family::Monitors),
        ("/mock-servers", Family::MockServers),
        ("/schemas", Family::Schemas),
        ("/integrations", Family::Integrations),
        ("/scim", Family::Scim),
    ];
    for (prefix, family) in PREFIXES {
        if let Some(rest) = path.strip_prefix(prefix) {
            // "/collectionsx" must not match; "/collections" and "/collections/…" must.
            if rest.is_empty() || rest.starts_with('/') {
                return Some((family, rest.trim_start_matches('/')));
            }
        }
    }
    None
}

fn family_base(family: Family) -> &'static str {
    match family {
        Family::Workspaces => "/workspaces",
        Family::Collections => "/collections",
        Family::Environments => "/environments",
        Family::Apis => "/apis",
        Family::Monitors => "/monitors",
        Family::MockServers => "/mock-servers",
        Family::Schemas => "/schemas",
        Family::Integrations => "/integrations",
        Family::Scim => "/scim",
    }
}

/// The path as it goes upstream (trailing slashes were stripped on the way in).
fn full_path(family: Family, rest: &str) -> String {
    if rest.is_empty() {
        family_base(family).to_string()
    } else {
        format!("{}/{}", family_base(family), rest)
    }
}

/// Key details that differ between collections and environments:
/// (sqlite map table, Postman list key, singular key).
fn dialect(family: Family) -> (&'static str, &'static str, &'static str) {
    match family {
        Family::Collections => ("collections_map", "collections", "collection"),
        Family::Environments => ("environments_map", "environments", "environment"),
        _ => unreachable!("dialect on unscoped family"),
    }
}

/// Who the proxied request belongs to, for the audit row.
struct Who {
    user_id: Option<i64>,
    email: Option<String>,
}

struct Principal {
    user_id: Option<i64>,
    email: Option<String>,
    role: String,
    /// None = all workspaces; Some = only these workspace IDs.
    grants: Option<Vec<String>>,
}

impl Principal {
    fn rank(&self) -> u8 {
        rank(&self.role)
    }

    /// Admins and NULL-grant principals bypass scoping entirely; a granted
    /// principal may only touch workspaces in its list.
    fn scope(&self) -> Option<&[String]> {
        if self.role == "admin" || self.grants.is_none() {
            None
        } else {
            Some(self.grants.as_deref().unwrap_or(&[]))
        }
    }
}

/// Enforced mode always requires a valid Bearer token. Open mode treats every
/// request as an implicit editor with no grants, unless the caller happens to
/// present a valid token (e.g. the admin principal from /auth/admin-login).
fn resolve_principal(state: &AppState, authorization: Option<&str>) -> Result<Principal, Response> {
    let token = authorization.and_then(extract_bearer);
    let principal_from = |user: Option<crate::auth::AuthUser>| user.map(|auth_user| Principal {
        user_id: Some(auth_user.user_id),
        email: Some(auth_user.email),
        role: auth_user.role,
        grants: auth_user.grants,
    });
    if !state.config.require_auth {
        if let Some(token) = token {
            if let Some(principal) = principal_from(token_principal(state, token)) {
                return Ok(principal);
            }
        }
        return Ok(Principal {
            user_id: None,
            email: None,
            role: "editor".to_string(),
            grants: None,
        });
    }
    let Some(token) = token else {
        return Err(error(StatusCode::UNAUTHORIZED, "Invalid or missing token"));
    };
    principal_from(token_principal(state, token))
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Invalid or missing token"))
}

fn extract_bearer(value: &str) -> Option<&str> {
    let (scheme, rest) = value.trim().split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
        Some(rest.trim())
    } else {
        None
    }
}

/// Minimum role for each proxied call, plus the message for when that exact
/// tier is what was missed.
fn min_role(family: Family, method: &Method, has_uid: bool) -> (u8, &'static str) {
    if matches!(method.as_str(), "GET" | "HEAD") {
        return (rank("viewer"), "");
    }
    if method == Method::DELETE {
        return if has_uid && matches!(family, Family::Collections | Family::Environments) {
            (rank("admin"), "Only admins can delete collections and environments")
        } else {
            (rank("editor"), "")
        };
    }
    // POST / PATCH / PUT and anything else: editor+, while creating a
    // collection and touching apis/monitors/mock-servers/schemas needs creator+.
    let creator_only = (!has_uid && family == Family::Collections)
        || matches!(
            family,
            Family::Apis | Family::Monitors | Family::MockServers | Family::Schemas
        );
    if creator_only {
        (rank("creator"), "This action requires the creator role or above")
    } else {
        (rank("editor"), "")
    }
}

/// The proxy fallback: every non-contract path lands here (contract paths are
/// their own routes above), then gets validated, scoped, forwarded audited.
pub async fn proxy(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let (parts, body_stream) = request.into_parts();
    let method = parts.method.clone();
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();
    let authorization = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    let body = match axum::body::to_bytes(body_stream, MAX_PROXY_BODY).await {
        Ok(body) => body,
        Err(_) => {
            let too_large = error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large");
            return audit(state, method, path, too_large, Who { user_id: None, email: None });
        }
    };

    let (response, who) =
        handle(&state, &method, &path, &query, authorization.as_deref(), body).await;
    audit(state, method, path, response, who)
}

/// Logs every request that reaches the proxy: (ts, user_id, email, method,
/// path, status). Open-mode principals audit as NULL/NULL; a presented admin
/// principal audits as user 0 ("admin").
fn audit(state: Arc<AppState>, method: Method, path: String, response: Response, who: Who) -> Response {
    let status = response.status().as_u16() as i64;
    {
        let conn = lock_db(&state);
        let _ = db::audit_insert(
            &conn,
            &db::now_iso(),
            who.user_id,
            who.email.as_deref(),
            method.as_str(),
            &path,
            status,
        );
    }
    response
}

async fn handle(
    state: &Arc<AppState>,
    method: &Method,
    path: &str,
    query: &str,
    authorization: Option<&str>,
    body: Bytes,
) -> (Response, Who) {
    // 1. Principal.
    let principal = match resolve_principal(state, authorization) {
        Ok(principal) => principal,
        Err(resp) => {
            return (resp, Who { user_id: None, email: None });
        }
    };
    let who = Who {
        user_id: principal.user_id,
        email: principal.email.clone(),
    };

    // 2. Only the documented Postman API surface, and never absolute URLs.
    if !path.starts_with('/') || path.contains("://") || path.starts_with("//") {
        return (error(StatusCode::NOT_FOUND, "No such Postman endpoint"), who);
    }
    let Some((family, rest)) = family_of(path) else {
        return (error(StatusCode::NOT_FOUND, "No such Postman endpoint"), who);
    };

    // 3. The shared API key is a server-side prerequisite for proxying.
    let Some(key) = state.config.postman_api_key.clone() else {
        return (
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "This server has no Postman API key — set POSTMAN_API_KEY in the server's environment and restart it",
            ),
            who,
        );
    };

    // 4. Role matrix.
    let (needed, needed_msg) = min_role(family, method, !rest.is_empty());
    if principal.rank() < needed {
        let message = if principal.rank() == rank("viewer") {
            "Viewers have read-only access"
        } else if needed_msg.is_empty() {
            "Your role doesn't allow this action"
        } else {
            needed_msg
        };
        return (error(StatusCode::FORBIDDEN, message), who);
    }

    // 5. Scoping and forwarding (redaction and map upkeep happen inside).
    let response = match family {
        Family::Collections | Family::Environments => {
            scoped_or_plain(state, &key, family, method, rest, query, &body, &principal).await
        }
        Family::Workspaces => {
            workspaces(state, &key, method, rest, query, body, &principal).await
        }
        _ => passthrough(state, &key, method, &full_path(family, rest), query, body).await,
    };
    (response, who)
}

// ----- workspace-scoped resources (collections / environments) --------------

async fn scoped_or_plain(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: &Bytes,
    principal: &Principal,
) -> Response {
    let (table, _, thing) = dialect(family);
    let is_list = rest.is_empty();
    let is_create = is_list && method == Method::POST;

    if let Some(allowed) = principal.scope() {
        if is_create {
            return create_scoped(state, key, family, query, body, allowed).await;
        }
        if is_list {
            return list_scoped(state, key, family, table, list_key(family), query, allowed).await;
        }
        // Single-uid operation: the owning workspace comes from the sqlite
        // map, never from the request.
        let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
        let mapped = {
            let conn = lock_db(state);
            db::mapped_workspace(&conn, table, &uid).ok().flatten()
        };
        match mapped {
            Some(workspace) if allowed.iter().any(|allowed_ws| *allowed_ws == workspace) => {
                forward_single(state, key, family, method, rest, query, body, principal).await
            }
            _ => error(
                StatusCode::FORBIDDEN,
                format!("This {thing} isn't in one of your workspaces — refresh your {thing}s list first"),
            ),
        }
    } else {
        // Grants NULL (or admin): the call passes through as-is, but we still
        // learn uid → workspace from every per-workspace list/create/delete.
        plain_forward(state, key, family, method, rest, query, body, principal).await
    }
}

fn list_key(family: Family) -> &'static str {
    dialect(family).1
}

/// Unscoped passthrough. Maintains the uid→workspace map from per-workspace
/// lists, creates and deletes; redacts viewers' single-item GETs.
async fn plain_forward(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: &Bytes,
    principal: &Principal,
) -> Response {
    let (table, _, thing) = dialect(family);
    let is_list = rest.is_empty();
    let is_create = is_list && method == Method::POST;
    let is_delete_single = !is_list && method == Method::DELETE;
    // The workspace this call belongs to, when the caller declared one.
    let declared_workspace = if is_create {
        find_workspace_in(body, query)
    } else if is_list {
        query_workspace(query).map(str::to_string)
    } else {
        None
    };

    let upstream = match forward_to_postman(state, key, method, &full_path(family, rest), query, body).await {
        Ok(upstream) => upstream,
        Err(resp) => return resp,
    };

    if upstream.status.is_success() {
        if is_delete_single {
            let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
            let conn = lock_db(state);
            let _ = db::forget_entry(&conn, table, &uid);
        } else if let Some(workspace) = declared_workspace {
            if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
                if let Some(entries) = list_entries(&value, list_key(family), thing) {
                    let conn = lock_db(state);
                    let _ = db::remember_entries(&conn, table, &workspace, &Value::Array(entries));
                }
            }
        }
    }

    if should_redact(principal, method, rest) && upstream.status.is_success() {
        return match strip_current_values(&upstream.body) {
            Some(stripped) => as_response(upstream, Some(stripped)),
            None => as_response(upstream, None),
        };
    }
    as_response(upstream, None)
}

/// Viewer + GET on a single collection/environment ⇒ strip `currentValue`s.
fn should_redact(principal: &Principal, method: &Method, rest: &str) -> bool {
    principal.role == "viewer" && method == Method::GET && !rest.is_empty() && !rest.contains('/')
}

/// One entry (object) or a whole list (array) from a list/create response.
fn list_entries(value: &Value, list_key: &str, thing: &str) -> Option<Vec<Value>> {
    if let Some(list) = value.get(list_key).and_then(Value::as_array) {
        return Some(list.clone());
    }
    // Create responses carry the single object under its singular key.
    let single = value.get(thing)?;
    single.is_object().then(|| vec![single.clone()])
}

/// GET on the list endpoint with grants: an explicitly requested workspace is
/// served from cache/upstream if granted; otherwise every granted workspace's
/// lists are fetched (60s cached) and merged.
async fn list_scoped(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    table: &str,
    list_key: &str,
    query: &str,
    allowed: &[String],
) -> Response {
    if allowed.is_empty() {
        let mut empty_map = serde_json::Map::new();
        empty_map.insert(list_key.to_string(), Value::Array(Vec::new()));
        return json(StatusCode::OK, &Value::Object(empty_map));
    }
    match query_workspace(query) {
        Some(requested) if allowed.iter().any(|ws| ws == requested) => {
            match cached_workspace_list(state, key, family, table, query, requested).await {
                Ok(upstream) => as_response(upstream, None),
                Err(resp) => resp,
            }
        }
        Some(_) => error(StatusCode::FORBIDDEN, "This workspace isn't in one of your workspaces"),
        None => merged_lists(state, key, family, table, allowed).await,
    }
}

/// Per-workspace list fetch: answers from the 60s cache when fresh; on a
/// cache/stream miss calls upstream, then populates cache and the uid map.
/// Responses come back byte-verbatim.
async fn cached_workspace_list(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    table: &str,
    query: &str,
    workspace: &str,
) -> Result<Upstream, Response> {
    let base = family_base(family);
    let cache_key = format!("{base}:{workspace}");
    if let Some(cached) = fresh_cached_list(state, &cache_key) {
        return Ok(cached);
    }
    let scoped_query = query_with_workspace(query, workspace);
    let upstream = forward_to_postman(state, key, &Method::GET, base, &scoped_query, &Bytes::new())
        .await?
        ;
    if upstream.status.is_success() {
        if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
            if let Some(entries) = list_entries(&value, list_key(family), dialect(family).2) {
                let conn = lock_db(state);
                let _ = db::remember_entries(&conn, table, workspace, &Value::Array(entries));
            }
        }
        {
            let mut cache = lock_cache(state);
            cache.insert(
                cache_key.clone(),
                CachedList {
                    at: Instant::now(),
                    rate: upstream.rate.clone(),
                    body: upstream.body.clone(),
                },
            );
        }
    }
    Ok(upstream)
}

fn fresh_cached_list(state: &Arc<AppState>, cache_key: &str) -> Option<Upstream> {
    let cache = lock_cache(state);
    cache.get(cache_key).filter(|entry| entry.at.elapsed() < LIST_CACHE_TTL).map(|entry| Upstream {
        status: StatusCode::OK,
        rate: entry.rate.clone(),
        content_type: Some("application/json".to_string()),
        body: entry.body.clone(),
    })
}

/// Merges the per-workspace list responses of every granted workspace into
/// one list; a failing workspace's upstream status/body passes through
/// verbatim (failures are never cached).
async fn merged_lists(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    table: &str,
    allowed: &[String],
) -> Response {
    let (_, list_key, thing) = (family_base(family), list_key(family), dialect(family).2);
    let mut merged: Vec<Value> = Vec::new();
    let mut rate: Option<String> = None;
    let mut response_key = list_key.to_string();
    for workspace in allowed {
        let upstream = match cached_workspace_list(state, key, family, table, "", workspace).await {
            Ok(upstream) => upstream,
            Err(resp) => return resp,
        };
        if !upstream.status.is_success() {
            return as_response(upstream, None);
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
            if let Some(key_name) = value
                .as_object()
                .and_then(|map| map.keys().find(|key| **key == list_key || **key == thing).cloned())
            {
                response_key = key_name;
            }
            if let Some(entries) = list_entries(&value, list_key, thing) {
                merged.extend(entries);
            }
        }
        rate = upstream.rate.clone();
    }
    let mut body_map = serde_json::Map::new();
    body_map.insert(response_key, Value::Array(merged));
    json_with_rate(StatusCode::OK, &Value::Object(body_map), rate.as_deref())
}

/// POST /collections or /environments with grants: force the workspace in the
/// body to an allowed one (defaulting to the first), keep the query param in
/// sync for clients that carry the workspace there, and cache the mapping
/// from the create response.
async fn create_scoped(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    query: &str,
    body: &Bytes,
    allowed: &[String],
) -> Response {
    if allowed.is_empty() {
        return error(StatusCode::FORBIDDEN, "You have no granted workspaces");
    }
    let Ok(mut value) = serde_json::from_slice::<Value>(body) else {
        return error(StatusCode::BAD_REQUEST, "Body must be valid JSON");
    };
    let (table, _, thing) = dialect(family);
    let existing = find_workspace_in_value(&value, query);
    let chosen = match existing {
        Some(ws) if allowed.iter().any(|allowed_ws| *allowed_ws == ws) => ws,
        _ => allowed.first().cloned().unwrap_or_default(),
    };
    force_workspace_in_body(&mut value, &chosen);
    let forwarded_body = match serde_json::to_vec(&value) {
        Ok(bytes) => bytes,
        Err(_) => {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't re-encode the request body")
        }
    };
    let forwarded_query = query_with_workspace(query, &chosen);

    let upstream = match forward_to_postman_bytes(
        state,
        key,
        &Method::POST,
        family_base(family),
        &forwarded_query,
        forwarded_body,
    )
    .await
    {
        Ok(upstream) => upstream,
        Err(resp) => return resp,
    };
    if upstream.status.is_success() {
        if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
            if let Some(entries) = list_entries(&value, list_key(family), thing) {
                let conn = lock_db(state);
                let _ = db::remember_entries(&conn, table, &chosen, &Value::Array(entries));
            }
        }
    }
    as_response(upstream, None)
}

// ----- workspaces -----------------------------------------------------------

async fn workspaces(
    state: &Arc<AppState>,
    key: &str,
    method: &Method,
    rest: &str,
    query: &str,
    body: Bytes,
    principal: &Principal,
) -> Response {
    let base = "/workspaces";
    if let Some(allowed) = principal.scope() {
        if !rest.is_empty() {
            // Anything aimed at a workspace the principal can't see is denied.
            let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
            if !allowed.iter().any(|ws| *ws == uid) {
                return error(StatusCode::FORBIDDEN, "This workspace isn't in one of your workspaces");
            }
        } else if matches!(method.as_str(), "GET" | "HEAD") {
            // Filter the workspace list down to the granted IDs.
            let upstream = match forward_to_postman(state, key, method, base, query, &body).await {
                Ok(upstream) => upstream,
                Err(resp) => return resp,
            };
            if upstream.status.is_success() {
                if let Some(filtered) = filter_workspaces(&upstream.body, allowed) {
                    return json_with_rate(upstream.status, &filtered, upstream.rate.as_deref());
                }
            }
            return as_response(upstream, None);
        }
    }
    passthrough(state, key, method, &full_path(Family::Workspaces, rest), query, body).await
}

// ----- generic forwarding ---------------------------------------------------

/// Everything outside collections/environments/workspaces flows through verbatim.
async fn passthrough(
    state: &Arc<AppState>,
    key: &str,
    method: &Method,
    path: &str,
    query: &str,
    body: Bytes,
) -> Response {
    match forward_to_postman(state, key, method, path, query, &body).await {
        Ok(upstream) => as_response(upstream, None),
        Err(resp) => resp,
    }
}

/// Allowed single-uid call inside a granted workspace: forward verbatim, keep
/// the map in sync on deletes, redact viewers.
async fn forward_single(
    state: &Arc<AppState>,
    key: &str,
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: &Bytes,
    principal: &Principal,
) -> Response {
    let (table, _, _) = dialect(family);
    let upstream = match forward_to_postman(state, key, method, &full_path(family, rest), query, body).await
    {
        Ok(upstream) => upstream,
        Err(resp) => return resp,
    };
    if upstream.status.is_success() && method == Method::DELETE {
        let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
        let conn = lock_db(state);
        let _ = db::forget_entry(&conn, table, &uid);
    }
    if should_redact(principal, method, rest) && upstream.status.is_success() {
        if let Some(stripped) = strip_current_values(&upstream.body) {
            return as_response(upstream, Some(stripped));
        }
    }
    as_response(upstream, None)
}

struct Upstream {
    status: StatusCode,
    rate: Option<String>,
    content_type: Option<String>,
    body: Bytes,
}

/// The one upstream call: method + path + query + JSON body, authenticated
/// with the shared key, 60s timeout (on the shared client), responses passed
/// through verbatim (status, body, content-type, rate-limit header).
async fn forward_to_postman(
    state: &Arc<AppState>,
    key: &str,
    method: &Method,
    path: &str,
    query: &str,
    body: &Bytes,
) -> Result<Upstream, Response> {
    forward_to_postman_bytes(state, key, method, path, query, body.to_vec()).await
}

async fn forward_to_postman_bytes(
    state: &Arc<AppState>,
    key: &str,
    method: &Method,
    path: &str,
    query: &str,
    body: Vec<u8>,
) -> Result<Upstream, Response> {
    let mut url = format!("{}{}", state.config.postman_base, path);
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    let mut request = state
        .http
        .request(method.clone(), &url)
        .header("X-Api-Key", key)
        .header("Accept", "application/json");
    if !body.is_empty() {
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let upstream_resp = match request.send().await {
        Ok(resp) => resp,
        Err(_) => {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "Couldn't reach the Postman API. Check the server's internet connection.",
            ))
        }
    };
    let status = upstream_resp.status();
    let rate = upstream_resp
        .headers()
        .get(RATE_LIMIT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_type = upstream_resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let upstream_body = upstream_resp.bytes().await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "Couldn't read the response from the Postman API",
        )
    })?;
    Ok(Upstream {
        status,
        rate,
        content_type,
        body: upstream_body,
    })
}

fn as_response(upstream: Upstream, body_override: Option<Bytes>) -> Response {
    let content_type = upstream
        .content_type
        .unwrap_or_else(|| "application/json".to_string());
    let mut builder = Response::builder()
        .status(upstream.status)
        .header(header::CONTENT_TYPE, content_type);
    if let Some(rate) = upstream.rate {
        if let Ok(value) = axum::http::HeaderValue::from_str(&rate) {
            builder = builder.header(RATE_LIMIT_HEADER, value);
        }
    }
    builder
        .body(Body::from(body_override.unwrap_or(upstream.body)))
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Response construction failed"))
}

/// JSON response (merged/filtered lists) carrying the rate-limit header.
fn json_with_rate(status: StatusCode, value: &Value, rate: Option<&str>) -> Response {
    let mut response = json(status, value);
    if let Some(rate) = rate {
        if let Ok(header_value) = axum::http::HeaderValue::from_str(rate) {
            response.headers_mut().insert(RATE_LIMIT_HEADER, header_value);
        }
    }
    response
}

// ----- JSON body/query shaping ----------------------------------------------

/// Drops every `currentValue` field from a JSON body, keeping `value`;
/// returns None when the body isn't JSON.
fn strip_current_values(body: &Bytes) -> Option<Bytes> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    strip_value(&mut value);
    serde_json::to_vec(&value).ok().map(Bytes::from)
}

fn strip_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let _ = map.remove("currentValue");
            for child in map.values_mut() {
                strip_value(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_value),
        _ => {}
    }
}

/// Filters a GET /workspaces response down to the granted workspace IDs; None
/// (→ pass through unfiltered) only when the body isn't JSON.
fn filter_workspaces(body: &Bytes, allowed: &[String]) -> Option<Value> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    if let Some(list) = value.get_mut("workspaces").and_then(Value::as_array_mut) {
        list.retain(|ws| {
            ws.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| allowed.iter().any(|allowed_ws| allowed_ws == id))
        });
    }
    Some(value)
}

/// The `workspace` query parameter, if present and non-empty.
fn query_workspace(query: &str) -> Option<&str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "workspace" && !value.is_empty()).then_some(value)
    })
}

/// Rewrites/inserts the `workspace` query parameter, leaving other params.
fn query_with_workspace(query: &str, workspace: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut replaced = false;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        if pair.split('=').next() == Some("workspace") {
            kept.push(format!("workspace={workspace}"));
            replaced = true;
        } else {
            kept.push(pair.to_string());
        }
    }
    if !replaced {
        kept.push(format!("workspace={workspace}"));
    }
    kept.join("&")
}

/// The caller's declared workspace: body["workspace"]["id"], then
/// body["workspaceId"], then the `workspace` query parameter.
fn find_workspace_in(body: &Bytes, query: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    find_workspace_in_value(&value, query)
}

fn find_workspace_in_value(value: &Value, query: &str) -> Option<String> {
    value
        .get("workspace")
        .and_then(|ws| ws.get("id"))
        .and_then(Value::as_str)
        .or_else(|| value.get("workspaceId").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| query_workspace(query).map(str::to_string))
}

/// Forces the declared workspace into the body: an existing workspace object
/// simply gets its `id` replaced; otherwise `workspace` (and any explicit
/// `workspaceId`) is set to the chosen workspace.
fn force_workspace_in_body(value: &mut Value, workspace: &str) {
    let Some(map) = value.as_object_mut() else { return };
    match map.remove("workspace") {
        Some(Value::Object(ws_obj)) => {
            let mut ws_obj = ws_obj;
            ws_obj.insert("id".to_string(), json!(workspace));
            map.insert("workspace".to_string(), Value::Object(ws_obj));
        }
        _ => {
            map.insert("workspace".to_string(), json!({ "id": workspace }));
        }
    }
    if map.contains_key("workspaceId") {
        map.insert("workspaceId".to_string(), json!(workspace));
    }
}

/// Only uids are compared against the map; decode the percent-encoding the
/// URL carried so "1%2Ddemo" matches the stored "1-demo".
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}