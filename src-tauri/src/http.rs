//! Sends the user's HTTP requests natively, so there are no browser CORS limits.

use crate::cookies;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub key: String,
    /// "text" or "file"
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub value: String,
    /// Absolute path when kind == "file"
    #[serde(default)]
    pub src: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Body {
    None,
    Raw { content: String },
    Urlencoded { fields: Vec<KeyValue> },
    Formdata { fields: Vec<FormField> },
    File { path: String },
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "yes")]
    pub follow_redirects: bool,
    #[serde(default = "yes")]
    pub verify_ssl: bool,
    /// Full proxy URL; userinfo in the URL is used for proxy auth.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// Client certificate (PKCS#12/PFX or PEM with key) presented over TLS.
    #[serde(default)]
    pub client_cert: Option<ClientCert>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClientCert {
    /// Path to a .pfx/.p12 or a PEM file (cert and key concatenated).
    pub path: String,
    #[serde(default)]
    pub password: String,
}

fn default_timeout() -> u64 {
    30_000
}
fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings { timeout_ms: default_timeout(), follow_redirects: true, verify_ssl: true, proxy_url: None, client_cert: None }
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    pub body: Option<Body>,
    #[serde(default)]
    pub settings: Option<Settings>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IncomingResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<KeyValue>,
    pub url: String,
    pub content_type: String,
    /// Set when the body is valid UTF-8 text.
    pub body_text: Option<String>,
    /// Set when the body is binary (images, PDFs, ...).
    pub body_base64: Option<String>,
    pub size: usize,
    pub time_ms: u128,
    pub timings: Timings,
    /// The body arrived as a stream (Server-Sent Events, NDJSON) and was relayed live.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub streamed: bool,
    /// The user stopped the stream before the server ended it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
}

/// Live updates for a streaming response.
#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    #[serde(rename_all = "camelCase")]
    Head { status: u16, status_text: String, headers: Vec<KeyValue>, content_type: String },
    Chunk { text: String },
}

/// Where streamed chunks go, and how the user stops the stream.
pub struct StreamSink {
    pub on_event: Box<dyn Fn(StreamEvent) + Send + Sync>,
    pub cancel: Arc<tokio::sync::Notify>,
}

/// Content types relayed chunk by chunk.
fn is_streaming(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("text/event-stream") || ct.contains("ndjson") || ct.contains("jsonl") || ct.contains("stream+json")
}

const MAX_KEPT_STREAM: usize = 20 * 1024 * 1024;

/// Where the time went, in milliseconds. Every send uses a fresh connection,
/// so DNS and the handshake are always included (summed across redirects).
#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub dns_ms: f64,
    /// TCP connect plus the TLS handshake for https.
    pub connect_ms: f64,
    /// From the request going out to the first response byte.
    pub waiting_ms: f64,
    pub download_ms: f64,
    pub total_ms: f64,
    /// Connections opened (more than one means redirects to other hosts).
    pub connections: u32,
}

pub struct HttpState {
    pub jar: Arc<cookies::Jar>,
    /// Streaming sends in flight, by id, so they can be stopped.
    pub streams: Mutex<std::collections::HashMap<String, Arc<tokio::sync::Notify>>>,
}

impl HttpState {
    pub fn new() -> Self {
        HttpState { jar: Arc::new(cookies::Jar::default()), streams: Mutex::default() }
    }
}

// ---------- timing hooks ----------

#[derive(Default)]
struct Phases {
    dns: Duration,
    /// Whole connector call: DNS + TCP + TLS.
    connect: Duration,
    connections: u32,
}
type PhaseLog = Arc<Mutex<Phases>>;

fn phases(log: &PhaseLog) -> std::sync::MutexGuard<'_, Phases> {
    log.lock().unwrap_or_else(|p| p.into_inner())
}

/// System resolver (getaddrinfo, like reqwest's default) that records how long lookups take.
struct TimedResolver(PhaseLog);

impl reqwest::dns::Resolve for TimedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let log = self.0.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let started = Instant::now();
            let found = tokio::net::lookup_host((host.as_str(), 0)).await;
            phases(&log).dns += started.elapsed();
            let addrs: Vec<SocketAddr> = found.map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?.collect();
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Wraps reqwest's connector to time each new connection.
#[derive(Clone)]
struct TimingLayer(PhaseLog);

impl<S> tower::Layer<S> for TimingLayer {
    type Service = TimingConnector<S>;
    fn layer(&self, inner: S) -> Self::Service {
        TimingConnector { inner, log: self.0.clone() }
    }
}

#[derive(Clone)]
struct TimingConnector<S> {
    inner: S,
    log: PhaseLog,
}

impl<S, R> tower::Service<R> for TimingConnector<S>
where
    S: tower::Service<R>,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: R) -> Self::Future {
        let log = self.log.clone();
        let fut = self.inner.call(req);
        Box::pin(async move {
            let started = Instant::now();
            let out = fut.await;
            let mut p = phases(&log);
            p.connect += started.elapsed();
            p.connections += 1;
            out
        })
    }
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1_000_000.0).round() / 1000.0
}

const USER_AGENT: &str = concat!("Dispatch/", env!("CARGO_PKG_VERSION"));

pub async fn send(state: &HttpState, req: OutgoingRequest) -> Result<IncomingResponse, String> {
    send_with(state, req, None).await
}

/// Like `send`, but streaming responses are relayed to `sink` as they arrive.
/// Client settings shared by single sends and load tests: redirects, TLS,
/// proxy and client certificate.
pub async fn client_builder(settings: &Settings) -> Result<reqwest::ClientBuilder, String> {
    let redirect = if settings.follow_redirects {
        reqwest::redirect::Policy::limited(10)
    } else {
        reqwest::redirect::Policy::none()
    };
    let mut client = reqwest::Client::builder()
        .redirect(redirect)
        .danger_accept_invalid_certs(!settings.verify_ssl)
        .user_agent(USER_AGENT)
        // native-tls (schannel on Windows, openssl on Linux, Security on macOS)
        // so client certificates work on all three platforms.
        .use_native_tls();
    if let Some(proxy_url) = settings.proxy_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("Bad proxy URL: {e}"))?;
        client = client.proxy(proxy);
    }
    if let Some(cert) = &settings.client_cert {
        let bytes = read_cert_file(cert).await?;
        let identity = if cert.path.to_ascii_lowercase().ends_with(".p12") || cert.path.to_ascii_lowercase().ends_with(".pfx") {
            reqwest::Identity::from_pkcs12_der(&bytes, &cert.password)
                .map_err(|e| format!("Couldn't load the .pfx/.p12 certificate (wrong password?): {e}"))?
        } else {
            let (certs, key) = split_pem(&String::from_utf8_lossy(&bytes))
                .ok_or_else(|| "The PEM file must contain the certificate(s) and a private key.".to_string())?;
            reqwest::Identity::from_pkcs8_pem(certs.as_bytes(), key.as_bytes())
                .map_err(|e| format!("Couldn't load the PEM certificate ({e})"))?
        };
        client = client.identity(identity);
    }
    Ok(client)
}

/// The method, URL, headers and body of `req` on `client`, ready to send.
pub async fn build_request(client: &reqwest::Client, req: &OutgoingRequest) -> Result<reqwest::RequestBuilder, String> {
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("\"{}\" isn't a valid HTTP method", req.method))?;

    let url = normalise_url(&req.url)?;
    let mut builder = client.request(method, url);

    for h in &req.headers {
        if h.key.trim().is_empty() {
            continue;
        }
        builder = builder.header(h.key.trim(), &h.value);
    }

    builder = match req.body.clone().unwrap_or(Body::None) {
        Body::None => builder,
        Body::Raw { content } => builder.body(content),
        Body::Urlencoded { fields } => {
            let pairs: Vec<(String, String)> = fields.into_iter().map(|f| (f.key, f.value)).collect();
            builder.form(&pairs)
        }
        Body::Formdata { fields } => {
            let mut form = reqwest::multipart::Form::new();
            for f in fields {
                if f.kind == "file" {
                    let path = f.src.unwrap_or_default();
                    if path.is_empty() {
                        continue;
                    }
                    let bytes = tokio::fs::read(&path)
                        .await
                        .map_err(|e| format!("Couldn't read the file for \"{}\" ({path}): {e}", f.key))?;
                    let name = std::path::Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "file".into());
                    let mime = mime_guess::from_path(&path).first_or_octet_stream();
                    let part = reqwest::multipart::Part::bytes(bytes)
                        .file_name(name)
                        .mime_str(mime.as_ref())
                        .map_err(|e| e.to_string())?;
                    form = form.part(f.key, part);
                } else {
                    form = form.text(f.key, f.value);
                }
            }
            builder.multipart(form)
        }
        Body::File { path } => {
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| format!("Couldn't read the body file ({path}): {e}"))?;
            builder.body(bytes)
        }
    };
    Ok(builder)
}

pub async fn send_with(state: &HttpState, req: OutgoingRequest, sink: Option<&StreamSink>) -> Result<IncomingResponse, String> {
    let settings = req.settings.clone().unwrap_or_default();
    let log: PhaseLog = Arc::default();
    let mut client = client_builder(&settings)
        .await?
        .cookie_provider(state.jar.clone())
        .dns_resolver(Arc::new(TimedResolver(log.clone())))
        .connector_layer(TimingLayer(log.clone()));
    let timeout = Duration::from_millis(settings.timeout_ms.max(1));
    // A stream may run for minutes, so it only times out when the server goes quiet.
    client = if sink.is_some() { client.connect_timeout(timeout).read_timeout(timeout) } else { client.timeout(timeout) };
    let client = client.build()
        .map_err(|e| format!("Could not set up the HTTP client: {e}"))?;
    let builder = build_request(&client, &req).await?;

    let started = Instant::now();
    let resp = builder.send().await.map_err(describe_error)?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    let headers: Vec<KeyValue> = resp
        .headers()
        .iter()
        .map(|(k, v)| KeyValue {
            key: k.to_string(),
            value: String::from_utf8_lossy(v.as_bytes()).to_string(),
        })
        .collect();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let first_byte = started.elapsed();
    let mut streamed = false;
    let mut stopped = false;
    let bytes: Vec<u8> = match sink {
        Some(sink) if is_streaming(&content_type) => {
            streamed = true;
            (sink.on_event)(StreamEvent::Head { status: status.as_u16(), status_text: status.canonical_reason().unwrap_or("").to_string(), headers: headers.clone(), content_type: content_type.clone() });
            let mut resp = resp;
            let mut kept = Vec::new();
            let mut pending: Vec<u8> = Vec::new(); // a UTF-8 character split across chunks
            loop {
                let chunk = tokio::select! {
                    c = resp.chunk() => c.map_err(describe_error)?,
                    _ = sink.cancel.notified() => { stopped = true; None }
                };
                let Some(chunk) = chunk else { break };
                pending.extend_from_slice(&chunk);
                let valid = match std::str::from_utf8(&pending) { Ok(_) => pending.len(), Err(e) => e.valid_up_to() };
                if valid > 0 {
                    (sink.on_event)(StreamEvent::Chunk { text: String::from_utf8_lossy(&pending[..valid]).to_string() });
                }
                if kept.len() < MAX_KEPT_STREAM {
                    kept.extend_from_slice(&pending[..valid]);
                }
                pending.drain(..valid);
                if pending.len() > 4 {
                    pending.clear(); // not text after all
                }
            }
            kept
        }
        _ => resp.bytes().await.map_err(describe_error)?.to_vec(),
    };
    let total = started.elapsed();
    let time_ms = total.as_millis();
    let timings = {
        let p = phases(&log);
        Timings {
            dns_ms: ms(p.dns),
            connect_ms: ms(p.connect.saturating_sub(p.dns)),
            waiting_ms: ms(first_byte.saturating_sub(p.connect)),
            download_ms: ms(total - first_byte),
            total_ms: ms(total),
            connections: p.connections,
        }
    };
    let size = bytes.len();

    let (body_text, body_base64) = if looks_binary(&content_type) {
        (None, Some(base64::engine::general_purpose::STANDARD.encode(&bytes)))
    } else {
        match String::from_utf8(bytes.to_vec()) {
            Ok(s) => (Some(s), None),
            Err(_) => (None, Some(base64::engine::general_purpose::STANDARD.encode(&bytes))),
        }
    };

    Ok(IncomingResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        url: final_url,
        content_type,
        body_text,
        body_base64,
        size,
        time_ms,
        timings,
        streamed,
        stopped,
    })
}

/// Splits a PEM file into its certificate blocks and its private-key block.
/// Accepts PKCS#8 ("PRIVATE KEY") and legacy PKCS#1 ("RSA PRIVATE KEY") keys.
pub fn split_pem(text: &str) -> Option<(String, String)> {
    let mut certs = Vec::new();
    let mut key = None;
    let mut block: Option<(String, String)> = None; // (label, body)
    let mut finish = |b: &mut Option<(String, String)>| {
        if let Some((label, body)) = b.take() {
            let full = format!("-----BEGIN {label}-----\n{body}-----END {label}-----\n");
            if label.contains("CERTIFICATE") {
                certs.push(full);
            } else if label.contains("PRIVATE KEY") {
                key = Some(full);
            }
        }
    };
    for line in text.lines() {
        let trim = line.trim();
        if let Some(rest) = trim.strip_prefix("-----BEGIN ") {
            if let Some(label) = rest.strip_suffix("-----") {
                finish(&mut block);
                block = Some((label.to_string(), String::new()));
            }
        } else if trim.starts_with("-----END ") {
            finish(&mut block);
        } else if let Some((_, body)) = block.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    finish(&mut block);
    if certs.is_empty() || key.is_none() {
        return None;
    }
    Some((certs.concat(), key.unwrap()))
}

/// Reads a client certificate file (PKCS#12 .pfx/.p12, or PEM with cert + key).
async fn read_cert_file(cert: &ClientCert) -> Result<Vec<u8>, String> {
    if cert.path.is_empty() {
        return Err("Pick a client certificate file or clear the field.".into());
    }
    tokio::fs::read(&cert.path)
        .await
        .map_err(|e| format!("Couldn't read the certificate file ({0}): {e}", cert.path))
}

/// Accept "example.com/x" the way Postman does, by assuming http://.
fn normalise_url(raw: &str) -> Result<reqwest::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a URL to send the request to.".into());
    }
    if let Some(start) = trimmed.find("{{") {
        let name = trimmed[start + 2..].split("}}").next().unwrap_or("").trim();
        return Err(format!(
            "The URL uses {{{{{name}}}}}, which isn't defined. Select an environment that has it, or add it to the collection's variables."
        ));
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("http://{trimmed}") };
    reqwest::Url::parse(&with_scheme).map_err(|e| format!("Couldn't read the URL \"{trimmed}\": {e}"))
}

fn looks_binary(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.contains("application/pdf")
        || ct.contains("application/zip")
        || ct.contains("application/octet-stream")
}

fn describe_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return "The request timed out. You can raise the timeout in Settings.".into();
    }
    if e.is_connect() {
        let mut msg = String::from("Couldn't connect to the server");
        if let Some(src) = std::error::Error::source(&e) {
            msg.push_str(&format!(": {src}"));
        }
        return msg;
    }
    if e.is_redirect() {
        return "Too many redirects. Turn off \"Follow redirects\" in Settings to see the first response.".into();
    }
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(&format!(": {s}"));
        src = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Minimal HTTP server: echoes the raw request back as the body.
    fn echo_server(reply_headers: &'static str, reply_body: Option<Vec<u8>>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten().take(1) {
                let mut buf = vec![0u8; 65536];
                let mut got = Vec::new();
                s.set_read_timeout(Some(Duration::from_millis(300))).ok();
                while let Ok(n) = s.read(&mut buf) {
                    if n == 0 { break; }
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got);
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if got.len() >= i + 4 + len { break; }
                    }
                }
                let body = reply_body.clone().unwrap_or(got);
                let head = format!("HTTP/1.1 201 Created\r\n{reply_headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                s.write_all(head.as_bytes()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        format!("http://{addr}")
    }

    fn req(url: String, method: &str, body: Option<Body>) -> OutgoingRequest {
        OutgoingRequest {
            method: method.into(),
            url,
            headers: vec![KeyValue { key: "X-Test".into(), value: "yes".into() }, KeyValue { key: " ".into(), value: "skipped".into() }],
            body,
            settings: None,
        }
    }

    #[tokio::test]
    async fn sends_method_headers_and_raw_body() {
        let url = echo_server("Content-Type: text/plain\r\n", None);
        let r = send(&HttpState::new(), req(format!("{url}/a?b=1"), "patch", Some(Body::Raw { content: "{\"x\":1}".into() }))).await.unwrap();
        assert_eq!(r.status, 201);
        assert_eq!(r.status_text, "Created");
        let echoed = r.body_text.unwrap();
        assert!(echoed.starts_with("PATCH /a?b=1 HTTP/1.1"), "{echoed}");
        assert!(echoed.to_lowercase().contains("x-test: yes"));
        assert!(echoed.ends_with("{\"x\":1}"));
        assert!(echoed.contains("Dispatch/"));
    }

    #[tokio::test]
    async fn urlencoded_and_multipart() {
        let url = echo_server("", None);
        let r = send(&HttpState::new(), req(url, "POST", Some(Body::Urlencoded { fields: vec![KeyValue { key: "a b".into(), value: "c&d".into() }] }))).await.unwrap();
        let t = r.body_text.unwrap();
        assert!(t.contains("application/x-www-form-urlencoded"));
        assert!(t.ends_with("a+b=c%26d"), "{t}");

        let url = echo_server("", None);
        let f = FormField { key: "name".into(), kind: "text".into(), value: "Ada".into(), src: None };
        let r = send(&HttpState::new(), req(url, "POST", Some(Body::Formdata { fields: vec![f] }))).await.unwrap();
        let t = r.body_text.unwrap();
        assert!(t.contains("multipart/form-data; boundary="));
        assert!(t.contains("name=\"name\"") && t.contains("Ada"));
    }

    #[tokio::test]
    async fn reports_timings_and_keeps_cookies() {
        let url = echo_server("Set-Cookie: sid=1; Path=/\r\n", Some(b"ok".to_vec()));
        let state = HttpState::new();
        let url = url.replace("127.0.0.1", "localhost");
        let r = send(&state, req(url, "GET", None)).await.unwrap();
        let t = &r.timings;
        assert_eq!(t.connections, 1);
        assert!(t.total_ms > 0.0 && t.total_ms >= t.dns_ms + t.connect_ms + t.waiting_ms + t.download_ms - 0.01, "{t:?}");
        assert!(t.dns_ms > 0.0, "localhost goes through the resolver: {t:?}");
        assert_eq!(state.jar.list().len(), 1);
    }

    /// Server that sends an SSE response in three timed pieces.
    fn sse_server() -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten().take(1) {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
                let parts: [&[u8]; 3] = [b"data: one\n\n", b"event: tick\ndata: tw\xc3", b"\xa9\n\n"];
                for bytes in parts {
                    s.write_all(format!("{:x}\r\n", bytes.len()).as_bytes()).unwrap();
                    s.write_all(bytes).unwrap();
                    s.write_all(b"\r\n").unwrap();
                    s.flush().unwrap();
                    std::thread::sleep(Duration::from_millis(40));
                }
                s.write_all(b"0\r\n\r\n").unwrap();
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn streams_server_sent_events() {
        let url = sse_server();
        let seen: Arc<Mutex<Vec<StreamEvent>>> = Arc::default();
        let s2 = seen.clone();
        let sink = StreamSink { on_event: Box::new(move |e| s2.lock().unwrap().push(e)), cancel: Arc::default() };
        let r = send_with(&HttpState::new(), req(url, "GET", None), Some(&sink)).await.unwrap();
        assert!(r.streamed && !r.stopped);
        assert_eq!(r.body_text.as_deref(), Some("data: one\n\nevent: tick\ndata: twé\n\n"));
        let events = seen.lock().unwrap();
        assert!(matches!(events[0], StreamEvent::Head { status: 200, .. }));
        let chunks: Vec<String> = events.iter().filter_map(|e| if let StreamEvent::Chunk { text } = e { Some(text.clone()) } else { None }).collect();
        assert!(chunks.len() >= 2, "{chunks:?}");
        assert_eq!(chunks.concat(), "data: one\n\nevent: tick\ndata: twé\n\n", "a character split across chunks arrives whole");
    }

    #[tokio::test]
    async fn streams_can_be_stopped() {
        let url = sse_server();
        let cancel: Arc<tokio::sync::Notify> = Arc::default();
        let c2 = cancel.clone();
        let sink = StreamSink { on_event: Box::new(move |e| { if matches!(e, StreamEvent::Chunk { .. }) { c2.notify_one(); } }), cancel };
        let r = send_with(&HttpState::new(), req(url, "GET", None), Some(&sink)).await.unwrap();
        assert!(r.stopped);
        assert_eq!(r.body_text.as_deref(), Some("data: one\n\n"));
    }

    #[tokio::test]
    async fn binary_responses_are_base64() {
        let url = echo_server("Content-Type: image/png\r\n", Some(vec![0x89, b'P', b'N', b'G', 0, 1]));
        let r = send(&HttpState::new(), req(url, "GET", None)).await.unwrap();
        assert!(r.body_text.is_none());
        assert_eq!(r.body_base64.unwrap(), "iVBORwAB");
        assert_eq!(r.size, 6);
    }

    #[tokio::test]
    async fn friendly_errors() {
        let e = send(&HttpState::new(), req("{{baseUrl}}/x".into(), "GET", None)).await.unwrap_err();
        assert!(e.contains("{{baseUrl}}, which isn't defined"), "{e}");
        let e = send(&HttpState::new(), req("".into(), "GET", None)).await.unwrap_err();
        assert!(e.contains("Enter a URL"));
        let e = send(&HttpState::new(), req("http://127.0.0.1:1".into(), "GET", None)).await.unwrap_err();
        assert!(e.starts_with("Couldn't connect"), "{e}");
        let e = send(&HttpState::new(), req("http://x".into(), "BAD METHOD", None)).await.unwrap_err();
        assert!(e.contains("valid HTTP method"));
    }

    #[test]
    fn url_without_scheme_gets_http() {
        assert_eq!(normalise_url("example.com/a").unwrap().as_str(), "http://example.com/a");
        assert_eq!(normalise_url(" https://x.io ").unwrap().as_str(), "https://x.io/");
    }
}

#[cfg(test)]
mod pem_tests {
    use super::split_pem;

    #[test]
    fn splits_certificate_chain_and_key() {
        let text = "extra text\n-----BEGIN CERTIFICATE-----\nAAA\nBBB\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nCCC\n-----END CERTIFICATE-----\nnoise\n-----BEGIN PRIVATE KEY-----\nKKK\n-----END PRIVATE KEY-----\ntrailing\n";
        let (certs, key) = split_pem(text).unwrap();
        assert!(certs.contains("AAA") && certs.contains("CCC"));
        assert_eq!(certs.matches("-----BEGIN").count(), 2);
        assert!(key.contains("KKK"));
    }

    #[test]
    fn accepts_legacy_rsa_key_blocks() {
        let text = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n-----BEGIN RSA PRIVATE KEY-----\nRRR\n-----END RSA PRIVATE KEY-----\n";
        let (_, key) = split_pem(text).unwrap();
        assert!(key.contains("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(key.contains("RRR"));
    }

    #[test]
    fn rejects_files_without_key_or_cert() {
        assert!(split_pem("-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n").is_none());
        assert!(split_pem("-----BEGIN RSA PRIVATE KEY-----\nRRR\n-----END RSA PRIVATE KEY-----\n").is_none());
        assert!(split_pem("nothing here").is_none());
    }
}
