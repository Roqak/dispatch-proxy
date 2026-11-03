//! The AI assistant: calls the Claude API with the user's own key, which stays
//! in the keychain and never reaches the page. Rust has no official Anthropic
//! SDK, so this is the documented raw HTTP + SSE shape.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.anthropic.com/v1";
const MODEL: &str = "claude-opus-5";
pub const KEY_SLOT: &str = "anthropic-api-key";

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub system: String,
    pub prompt: String,
    /// JSON Schema for structured output (every object needs additionalProperties: false).
    #[serde(default)]
    pub schema: Option<Value>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Text { text: String },
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
    pub model: String,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn client(read_timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(read_timeout)
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")))
        .use_native_tls()
        .build()
        .map_err(|e| e.to_string())
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 => "Anthropic rejected the API key. Check it under Settings → AI assistant.".into(),
        429 => format!("Rate limited by the Claude API: {msg}"),
        529 => "The Claude API is overloaded right now. Try again in a moment.".into(),
        _ => format!("Claude API error {}: {msg}", status.as_u16()),
    }
}

/// Checks a key with a cheap call before it's saved.
pub async fn verify_key(key: &str) -> Result<(), String> {
    let resp = client(Duration::from_secs(30))?
        .get(format!("{API}/models?limit=1"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Claude API: {e}"))?;
    let status = resp.status();
    if status.is_success() { Ok(()) } else { Err(api_error(status, &resp.text().await.unwrap_or_default())) }
}

pub fn request_body(ask: &Ask) -> Value {
    let mut body = json!({
        "model": MODEL,
        "max_tokens": 64000,
        "stream": true,
        // On a policy decline, Anthropic re-runs the request on its recommended fallback model.
        "fallbacks": "default",
        "system": ask.system,
        "messages": [{ "role": "user", "content": ask.prompt }],
    });
    if let Some(schema) = &ask.schema {
        body["output_config"] = json!({ "format": { "type": "json_schema", "schema": schema } });
    }
    body
}

/// Streams the answer's text through `on_event`; resolves with the whole answer.
pub async fn ask(key: &str, ask: Ask, cancel: std::sync::Arc<tokio::sync::Notify>, on_event: impl Fn(AiEvent)) -> Result<Answer, String> {
    ask_at(API, key, ask, cancel, on_event).await
}

async fn ask_at(api: &str, key: &str, ask: Ask, cancel: std::sync::Arc<tokio::sync::Notify>, on_event: impl Fn(AiEvent)) -> Result<Answer, String> {
    // Adaptive thinking can pause before the first text, so allow quiet stretches.
    let resp = client(Duration::from_secs(300))?
        .post(format!("{api}/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .json(&request_body(&ask))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Claude API: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(status, &resp.text().await.unwrap_or_default()));
    }
    let mut resp = resp;
    let mut answer = Answer::default();
    let mut buf = String::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut refusal: Option<String> = None;
    loop {
        let chunk = tokio::select! {
            c = resp.chunk() => c.map_err(|e| format!("The answer was cut off: {e}"))?,
            _ = cancel.notified() => return Err("Stopped.".into()),
        };
        let Some(chunk) = chunk else { break };
        pending.extend_from_slice(&chunk);
        let valid = match std::str::from_utf8(&pending) { Ok(_) => pending.len(), Err(e) => e.valid_up_to() };
        buf.push_str(&String::from_utf8_lossy(&pending[..valid]));
        pending.drain(..valid);
        while let Some(end) = buf.find("\n\n") {
            let event: String = buf.drain(..end + 2).collect();
            let data: String = event.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            match v["type"].as_str().unwrap_or("") {
                "message_start" => {
                    answer.model = v["message"]["model"].as_str().unwrap_or(MODEL).to_string();
                    answer.input_tokens = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
                }
                "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                    let text = v["delta"]["text"].as_str().unwrap_or("").to_string();
                    answer.text.push_str(&text);
                    on_event(AiEvent::Text { text });
                }
                "message_delta" => {
                    if let Some(r) = v["delta"]["stop_reason"].as_str() {
                        answer.stop_reason = r.to_string();
                        if r == "refusal" {
                            refusal = Some(v["delta"]["stop_details"]["explanation"].as_str().or(v["stop_details"]["explanation"].as_str()).unwrap_or("").to_string());
                        }
                    }
                    answer.output_tokens = v["usage"]["output_tokens"].as_u64().unwrap_or(answer.output_tokens);
                }
                "error" => return Err(format!("Claude API error: {}", v["error"]["message"].as_str().unwrap_or("unknown"))),
                _ => {}
            }
        }
    }
    if let Some(why) = refusal {
        return Err(if why.is_empty() { "Claude declined this request.".into() } else { format!("Claude declined this request: {why}") });
    }
    if answer.stop_reason == "max_tokens" {
        answer.text.push_str("\n\n(The answer hit the length limit and was cut off.)");
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_shape() {
        let b = request_body(&Ask { system: "s".into(), prompt: "p".into(), schema: Some(json!({ "type": "object", "properties": {}, "required": [], "additionalProperties": false })) });
        assert_eq!(b["model"], "claude-opus-5");
        assert_eq!(b["stream"], true);
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["messages"][0]["content"], "p");
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert!(b.get("thinking").is_none(), "adaptive thinking is the default on this model");
        let plain = request_body(&Ask { system: "s".into(), prompt: "p".into(), schema: None });
        assert!(plain.get("output_config").is_none());
    }

    /// One-shot server replying with a canned SSE body; returns the request it saw.
    fn sse_server(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 8192];
            s.set_read_timeout(Some(Duration::from_millis(300))).ok();
            while let Ok(n) = s.read(&mut buf) { if n == 0 { break; } got.extend_from_slice(&buf[..n]); if String::from_utf8_lossy(&got).contains("\"messages\"") { break; } }
            tx.send(String::from_utf8_lossy(&got).to_string()).ok();
            s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn streams_text_and_reports_usage() {
        let (url, seen) = sse_server("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":12}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"pm.test(\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"'ok')\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        let deltas = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let d2 = deltas.clone();
        let a = ask_at(&url, "sk-test", Ask { system: "sys".into(), prompt: "hi".into(), schema: None }, Default::default(), move |AiEvent::Text { text }| d2.lock().unwrap().push(text)).await.unwrap();
        assert_eq!(a.text, "pm.test('ok')");
        assert_eq!(*deltas.lock().unwrap(), vec!["pm.test(".to_string(), "'ok')".to_string()]);
        assert_eq!((a.input_tokens, a.output_tokens, a.stop_reason.as_str()), (12, 7, "end_turn"));
        let req = seen.recv().unwrap().to_lowercase();
        assert!(req.contains("x-api-key: sk-test") && req.contains("anthropic-version: 2023-06-01") && req.contains("anthropic-beta: server-side-fallback-2026-07-01"));
    }

    #[tokio::test]
    async fn refusals_become_errors() {
        let (url, _) = sse_server("data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":1}}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"},\"usage\":{\"output_tokens\":0}}\n\n");
        let e = ask_at(&url, "k", Ask { system: "s".into(), prompt: "p".into(), schema: None }, Default::default(), |_| {}).await.unwrap_err();
        assert!(e.starts_with("Claude declined"), "{e}");
    }

    #[test]
    fn friendly_api_errors() {
        assert!(api_error(reqwest::StatusCode::UNAUTHORIZED, "{}").contains("rejected the API key"));
        assert_eq!(api_error(reqwest::StatusCode::BAD_REQUEST, r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad thing"}}"#), "Claude API error 400: bad thing");
    }
}
