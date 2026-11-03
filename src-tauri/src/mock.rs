//! Local mock servers: serve a collection's saved examples on 127.0.0.1.
//! Matching follows Postman's mock servers: method + path (":id" and "{{id}}"
//! segments match anything), query parameters break ties, and the
//! x-mock-response-name / x-mock-response-code headers pick an example.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub method: String,
    /// "/pets/:id" — leading host/variables already stripped.
    pub path: String,
    #[serde(default)]
    pub query: Vec<(String, String)>,
    pub name: String,
    pub code: u16,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub delay_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    /// The example that answered, if any.
    pub example: Option<String>,
    pub ms: f64,
}

struct Running {
    port: u16,
    routes: Arc<RwLock<Vec<Route>>>,
    stop: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct Mocks {
    servers: Mutex<HashMap<String, Running>>,
}

pub type Logger = Arc<dyn Fn(LogEntry) + Send + Sync>;

impl Mocks {
    pub async fn start(&self, id: String, port: u16, routes: Vec<Route>, log: Logger) -> Result<u16, String> {
        self.stop(&id);
        let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {port} is already in use. Pick another, or 0 for any free port.")
            } else {
                format!("Couldn't start the mock server: {e}")
            }
        })?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let routes = Arc::new(RwLock::new(routes));
        let (tx, mut rx) = oneshot::channel();
        let shared = routes.clone();
        let sid = id.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let routes = shared.clone();
                        let log = log.clone();
                        let sid = sid.clone();
                        tokio::spawn(async move { let _ = serve(stream, routes, log, sid).await; });
                    }
                }
            }
        });
        self.servers.lock().unwrap_or_else(|p| p.into_inner()).insert(id, Running { port, routes, stop: Some(tx) });
        Ok(port)
    }

    pub fn update(&self, id: &str, routes: Vec<Route>) -> bool {
        match self.servers.lock().unwrap_or_else(|p| p.into_inner()).get(id) {
            Some(r) => {
                *r.routes.write().unwrap_or_else(|p| p.into_inner()) = routes;
                true
            }
            None => false,
        }
    }

    pub fn stop(&self, id: &str) -> bool {
        match self.servers.lock().unwrap_or_else(|p| p.into_inner()).remove(id) {
            Some(mut r) => {
                if let Some(tx) = r.stop.take() {
                    let _ = tx.send(());
                }
                true
            }
            None => false,
        }
    }

    /// Running mocks as (id, port).
    pub fn list(&self) -> Vec<(String, u16)> {
        self.servers.lock().unwrap_or_else(|p| p.into_inner()).iter().map(|(k, v)| (k.clone(), v.port)).collect()
    }
}

struct Incoming {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
}

async fn serve(mut stream: TcpStream, routes: Arc<RwLock<Vec<Route>>>, log: Logger, id: String) -> std::io::Result<()> {
    let started = Instant::now();
    let Some(req) = read_request(&mut stream).await? else { return Ok(()) };
    let header = |name: &str| req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());

    // CORS preflight, so browser front ends can call the mock directly.
    if req.method == "OPTIONS" && header("access-control-request-method").is_some() {
        let allow_headers = header("access-control-request-headers").unwrap_or_else(|| "*".into());
        let head = format!(
            "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: {allow_headers}\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(head.as_bytes()).await?;
        log(LogEntry { id, method: req.method, path: req.path, status: 204, example: Some("CORS preflight".into()), ms: elapsed(started) });
        return Ok(());
    }

    let chosen = {
        let routes = routes.read().unwrap_or_else(|p| p.into_inner());
        pick(&routes, &req, header("x-mock-response-name").as_deref(), header("x-mock-response-code").and_then(|c| c.trim().parse().ok())).cloned()
    };
    let (status, reason, headers, body, example) = match chosen {
        Some(r) => {
            if r.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(r.delay_ms.min(60_000))).await;
            }
            (r.code, reason_for(r.code), r.headers.clone(), r.body.clone(), Some(r.name.clone()))
        }
        None => {
            let body = serde_json::json!({
                "error": "No saved example matches this request",
                "method": req.method,
                "path": req.path,
                "hint": "Save a response as an example on the request in Dispatch, or check the method and path.",
            })
            .to_string();
            (404, "Not Found", vec![("Content-Type".to_string(), "application/json".to_string())], body, None)
        }
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    for (k, v) in &headers {
        let lk = k.to_ascii_lowercase();
        // The body is stored decoded and sent whole, so framing headers are ours to set.
        if matches!(lk.as_str(), "content-length" | "transfer-encoding" | "content-encoding" | "connection") || k.contains(['\r', '\n']) || v.contains(['\r', '\n']) {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("access-control-allow-origin")) {
        head.push_str("Access-Control-Allow-Origin: *\r\n");
    }
    head.push_str("X-Mock-Server: Dispatch\r\n");
    let body_bytes = if req.method == "HEAD" { Vec::new() } else { body.into_bytes() };
    head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body_bytes.len()));
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&body_bytes).await?;
    stream.flush().await?;
    log(LogEntry { id, method: req.method, path: req.path, status, example, ms: elapsed(started) });
    Ok(())
}

fn elapsed(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Incoming>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await.map_err(|_| std::io::ErrorKind::TimedOut)??;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return Ok(None);
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("GET").to_ascii_uppercase();
    let target = first.next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    // Drain a declared body (capped) so the client isn't cut off mid-send.
    let want: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0).min(10 * 1024 * 1024);
    let mut have = buf.len() - head_end - 4;
    while have < want {
        match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(n)) => have += n,
        }
    }
    let (path, qs) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let query = qs
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect();
    Ok(Some(Incoming { method, path: decode(path), query, headers }))
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(b) => {
                    out.push(b);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Best example for a request, or None.
fn pick<'a>(routes: &'a [Route], req: &Incoming, want_name: Option<&str>, want_code: Option<u16>) -> Option<&'a Route> {
    let segs: Vec<&str> = req.path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    let mut best: Option<(i64, &Route)> = None;
    for r in routes {
        if !(r.method.eq_ignore_ascii_case(&req.method) || r.method == "*" || (req.method == "HEAD" && r.method.eq_ignore_ascii_case("GET"))) {
            continue;
        }
        let Some(mut score) = path_score(&r.path, &segs) else { continue };
        if let Some(name) = want_name {
            if r.name != name {
                continue;
            }
        }
        if let Some(code) = want_code {
            if r.code != code {
                continue;
            }
        }
        for (k, v) in &r.query {
            match req.query.iter().find(|(qk, _)| qk == k) {
                Some((_, qv)) if qv == v => score += 3,
                Some(_) => score -= 1,
                None => score -= 1,
            }
        }
        // Prefer 2xx examples when nothing else decides.
        if (200..300).contains(&r.code) {
            score += 1;
        }
        if best.as_ref().map_or(true, |(s, _)| score > *s) {
            best = Some((score, r));
        }
    }
    best.map(|(_, r)| r)
}

fn path_score(pattern: &str, segs: &[&str]) -> Option<i64> {
    let pat: Vec<&str> = pattern.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    if pat.last() == Some(&"*") {
        if segs.len() < pat.len() - 1 {
            return None;
        }
    } else if pat.len() != segs.len() {
        return None;
    }
    let mut score = 0;
    for (i, p) in pat.iter().enumerate() {
        if *p == "*" {
            break;
        }
        let wildcard = p.starts_with(':') || (p.starts_with("{{") && p.ends_with("}}"));
        if wildcard {
            score += 1;
        } else if p.eq_ignore_ascii_case(segs[i]) {
            score += 10;
        } else {
            return None;
        }
    }
    Some(score)
}

fn reason_for(code: u16) -> &'static str {
    reqwest::StatusCode::from_u16(code).ok().and_then(|s| s.canonical_reason()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: &str, path: &str, name: &str, code: u16, body: &str) -> Route {
        Route { method: method.into(), path: path.into(), query: vec![], name: name.into(), code, headers: vec![("Content-Type".into(), "application/json".into()), ("Content-Length".into(), "999".into())], body: body.into(), delay_ms: 0 }
    }

    fn incoming(method: &str, path: &str) -> Incoming {
        Incoming { method: method.into(), path: path.into(), query: vec![], headers: vec![] }
    }

    #[test]
    fn literal_beats_variable_and_2xx_breaks_ties() {
        let routes = vec![route("GET", "/pets/:id", "any pet", 200, "{}"), route("GET", "/pets/mine", "mine", 200, "{}"), route("GET", "/pets/:id", "missing", 404, "{}")];
        assert_eq!(pick(&routes, &incoming("GET", "/pets/mine"), None, None).unwrap().name, "mine");
        assert_eq!(pick(&routes, &incoming("GET", "/pets/7"), None, None).unwrap().name, "any pet");
        assert_eq!(pick(&routes, &incoming("GET", "/pets/7"), None, Some(404)).unwrap().name, "missing");
        assert_eq!(pick(&routes, &incoming("GET", "/pets/7"), Some("missing"), None).unwrap().name, "missing");
        assert!(pick(&routes, &incoming("POST", "/pets/7"), None, None).is_none());
        assert!(pick(&routes, &incoming("GET", "/pets"), None, None).is_none());
        assert_eq!(pick(&routes, &incoming("HEAD", "/pets/mine"), None, None).unwrap().name, "mine");
    }

    #[test]
    fn query_parameters_break_ties() {
        let mut a = route("GET", "/search", "page 1", 200, "1");
        a.query = vec![("page".into(), "1".into())];
        let mut b = route("GET", "/search", "page 2", 200, "2");
        b.query = vec![("page".into(), "2".into())];
        let routes = vec![a, b];
        let mut req = incoming("GET", "/search");
        req.query = vec![("page".into(), "2".into())];
        assert_eq!(pick(&routes, &req, None, None).unwrap().name, "page 2");
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(decode("a%20b+c%2Fd%zz%"), "a b c/d%zz%");
    }

    #[tokio::test]
    async fn serves_examples_over_http() {
        let mocks = Mocks::default();
        let seen: Arc<Mutex<Vec<LogEntry>>> = Arc::default();
        let s2 = seen.clone();
        let port = mocks
            .start("m1".into(), 0, vec![route("GET", "/pets/:id", "pet", 200, "{\"id\":1}")], Arc::new(move |e| s2.lock().unwrap().push(e)))
            .await
            .unwrap();
        let get = |path: &str| {
            let url = format!("http://127.0.0.1:{port}{path}");
            async move { reqwest::get(url).await.unwrap() }
        };
        let r = get("/pets/42").await;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
        assert_eq!(r.text().await.unwrap(), "{\"id\":1}", "stored Content-Length is replaced");
        let r = get("/nope").await;
        assert_eq!(r.status(), 404);
        assert!(r.text().await.unwrap().contains("No saved example"));

        assert!(mocks.update("m1", vec![route("GET", "/pets/:id", "pet v2", 201, "{}")]));
        assert_eq!(get("/pets/1").await.status(), 201);
        let log = seen.lock().unwrap().clone();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].example.as_deref(), Some("pet"));
        assert_eq!(log[1].example, None);

        assert!(mocks.stop("m1"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(reqwest::get(format!("http://127.0.0.1:{port}/pets/1")).await.is_err(), "stopped");
    }
}
