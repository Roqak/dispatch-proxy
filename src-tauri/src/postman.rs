//! Thin client for the Postman API (https://api.postman.com, or the EU host),
//! and for self-hosted Dispatch servers, which mirror the same endpoint shapes.
//! Only documented endpoints are used, authenticated with the user's own key.

use serde_json::Value;
use std::time::Duration;

/// Shown when a Dispatch server rejects the stored token. The JS side watches
/// for this wording to offer "Sign in again" (see src/js/sync.js).
pub const SESSION_EXPIRED: &str = "Your Dispatch server session has expired — sign in again";

/// Where the client points: Postman's own API (X-Api-Key) or a self-hosted
/// Dispatch server (Bearer token at the user's own base URL).
pub enum Target {
    Postman { api_key: String, region: String },
    Server { base_url: String, token: String },
}

fn target_base(target: &Target) -> String {
    match target {
        Target::Postman { region, .. } => base(region).to_string(),
        Target::Server { base_url, .. } => base_url.trim_end_matches('/').to_string(),
    }
}

/// Postman hosts EU-region accounts separately.
fn base(region: &str) -> &'static str {
    if region == "eu" { "https://api.eu.postman.com" } else { "https://api.postman.com" }
}

/// Validate and normalise a Dispatch server base URL (no trailing slash).
pub fn server_base(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("The server URL must start with http:// or https://".into());
    }
    let authority = url.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    let authority = authority.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = host.split(':').next().unwrap_or("");
    if host.is_empty() {
        return Err("That server URL has no host, e.g. https://dispatch.example.com".into());
    }
    Ok(url.trim_end_matches('/').to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Email+password sign-in at a Dispatch server; returns the issued token.
pub async fn server_login(base_url: &str, email: &str, password: &str) -> Result<String, String> {
    let resp = client()?
        .post(format!("{base_url}/auth/login"))
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Couldn't reach your Dispatch server. Check the server URL in Settings → Profiles; your local copy is still available.".to_string()
            } else {
                format!("Dispatch server request failed: {e}")
            }
        })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("Dispatch server returned {status}: {}", error_detail(&json, &text)));
    }
    let token = json
        .get("token")
        .and_then(|v| v.as_str())
        .or_else(|| json.pointer("/access_token").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "The server's login response contained no token. Is it up to date?".to_string())?;
    Ok(token)
}

pub async fn call(target: &Target, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with('/') || path.contains("://") {
        return Err("Invalid Postman API path".into());
    }
    let base = target_base(target);
    let (header, value) = match target {
        Target::Postman { api_key, .. } => ("X-Api-Key", api_key.to_string()),
        Target::Server { token, .. } => ("Authorization", format!("Bearer {token}")),
    };
    let label = match target {
        Target::Postman { .. } => "Postman",
        Target::Server { .. } => "Dispatch server",
    };
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;

    let mut req = client()?
        .request(method, format!("{base}{path}"))
        .header(header, value)
        .header("Accept", "application/json");
    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            match target {
                Target::Postman { .. } => "Couldn't reach Postman. Check your internet connection; your local copy is still available.".to_string(),
                Target::Server { .. } => "Couldn't reach your Dispatch server. Check the server URL in Settings → Profiles; your local copy is still available.".to_string(),
            }
        } else {
            format!("{label} request failed: {e}")
        }
    })?;

    let status = resp.status();
    let remaining = resp
        .headers()
        .get("x-ratelimit-remaining-month")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let mut json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    if !status.is_success() {
        // Postman's error bodies come in a few shapes; Dispatch servers mirror them.
        let detail = error_detail(&json, &text);
        return Err(match target {
            Target::Postman { .. } => match status.as_u16() {
                401 => "Postman rejected the API key. Create a new one under Settings → API keys in Postman and paste it here.".into(),
                403 => format!("Your Postman account doesn't have permission for this: {detail}"),
                404 => format!("Postman couldn't find that item. It may have been deleted or moved: {detail}"),
                429 => "You've hit Postman's API rate limit. Wait a minute, or check your plan's monthly API limit.".into(),
                _ => format!("Postman returned {status}: {detail}"),
            },
            // The server mirrors Postman's error shapes; only the wording differs.
            Target::Server { .. } => match status.as_u16() {
                401 => SESSION_EXPIRED.into(),
                _ => format!("{label} returned {status}: {detail}"),
            },
        });
    }

    if let (Some(r), Value::Object(map)) = (remaining, &mut json) {
        map.insert("_rateLimitRemainingMonth".into(), Value::String(r));
    }
    Ok(json)
}

/// Postman (and mirrors of it) hide the human-readable reason in one of these fields.
fn error_detail(json: &Value, text: &str) -> String {
    ["/error/message", "/detail", "/message", "/title", "/error/name"]
        .iter()
        .find_map(|p| json.pointer(p).and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| text.chars().take(300).collect())
}