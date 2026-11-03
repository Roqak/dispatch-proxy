//! WebSocket connections driven from the request UI.
//! Each connection gets an id; frames stream back through a tauri Channel.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::http::{ClientCert, KeyValue};

pub struct WsState {
    inner: Mutex<HashMap<u32, tokio::sync::mpsc::Sender<WsCommand>>>,
}

enum WsCommand {
    Send(Message),
    Close(Option<u16>),
}

pub fn new() -> WsState {
    WsState { inner: Mutex::new(HashMap::new()) }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WsConnectOptions {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default = "yes")]
    pub verify_ssl: bool,
    #[serde(default)]
    pub client_cert: Option<ClientCert>,
}

fn yes() -> bool {
    true
}

fn next_id() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static IDS: AtomicU32 = AtomicU32::new(1);
    IDS.fetch_add(1, Ordering::Relaxed)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

use futures_util::StreamExt;

#[tauri::command]
pub async fn ws_connect(
    state: tauri::State<'_, WsState>,
    options: WsConnectOptions,
    on_event: Channel<Value>,
) -> Result<u32, String> {
    let mut request = options
        .url
        .into_client_request()
        .map_err(|e| format!("Not a valid WebSocket URL (use ws:// or wss://): {e}"))?;
    for h in &options.headers {
        if h.key.trim().is_empty() {
            continue;
        }
        let name: tauri::http::HeaderName = h.key.trim().parse().map_err(|e| format!("Bad header \"{}\": {e}", h.key))?;
        let value: tauri::http::HeaderValue = h.value.parse().map_err(|e| format!("Bad value for \"{}\": {e}", h.key))?;
        request.headers_mut().insert(name, value);
    }

    // TLS: native backend, honoring verifySSL and client certificates.
    let tls_connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(!options.verify_ssl)
        .build()
        .map_err(|e| format!("TLS setup failed: {e}"))?;
    let connector = if let Some(cert) = &options.client_cert {
        let bytes = tokio::fs::read(&cert.path)
            .await
            .map_err(|e| format!("Couldn't read the certificate file ({0}): {e}", cert.path))?;
        let identity = if cert.path.to_ascii_lowercase().ends_with(".p12") || cert.path.to_ascii_lowercase().ends_with(".pfx") {
            native_tls::Identity::from_pkcs12(&bytes, &cert.password).map_err(|e| format!("Couldn't load the .pfx/.p12 certificate (wrong password?): {e}"))?
        } else {
            let (certs, key) = crate::http::split_pem(&String::from_utf8_lossy(&bytes))
                .ok_or_else(|| "The PEM file must contain the certificate(s) and a private key.".to_string())?;
            native_tls::Identity::from_pkcs8(certs.as_bytes(), key.as_bytes()).map_err(|e| format!("Couldn't load the PEM certificate ({e})"))?
        };
        native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(!options.verify_ssl)
            .identity(identity)
            .build()
            .map_err(|e| format!("TLS setup failed: {e}"))?
    } else {
        tls_connector
    };

    let ws_stream = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(tokio_tungstenite::Connector::NativeTls(connector)),
    )
    .await
    .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let id: u32 = next_id();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel::<WsCommand>(64);
    if let Ok(mut inner) = state.inner.lock() {
        inner.insert(id, cmd_tx);
    }

    let _ = on_event.send(serde_json::json!({ "type": "Open", "id": id }));
    let (sink, read) = ws_stream.0.split();
    tokio::spawn(loop_task(id, sink, read, cmd_rx, on_event));
    Ok(id)
}

async fn loop_task(
    id: u32,
    sink: futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    read: futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
    mut cmd_rx: tokio::sync::mpsc::Receiver<WsCommand>,
    on_event: Channel<Value>,
) {
    use futures_util::{SinkExt, StreamExt};
    let mut sink = sink;
    let mut read = read;
    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let size = text.len() as u32;
                        let _ = on_event.send(serde_json::json!({ "type": "Message", "id": id, "direction": "in", "text": text, "size": size, "at": now_ms() }));
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let size = bytes.len() as u32;
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        let _ = on_event.send(serde_json::json!({ "type": "Message", "id": id, "direction": "in", "text": text, "size": size, "at": now_ms(), "binary": true }));
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = match frame {
                            Some(f) => (Some(u16::from(f.code)), f.reason.to_string()),
                            None => (None, String::new()),
                        };
                        let _ = on_event.send(serde_json::json!({ "type": "Closed", "id": id, "code": code, "reason": reason }));
                        break;
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        let _ = on_event.send(serde_json::json!({ "type": "Error", "id": id, "message": format!("{e}") }));
                        break;
                    }
                    None => {
                        let _ = on_event.send(serde_json::json!({ "type": "Closed", "id": id, "code": null, "reason": "stream ended" }));
                        break;
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(WsCommand::Send(m)) => {
                        if let Err(e) = sink.send(m).await {
                            let _ = on_event.send(serde_json::json!({ "type": "Error", "id": id, "message": format!("{e}") }));
                        }
                    }
                    Some(WsCommand::Close(code)) => {
                        let frame = code
                            .map(|c| Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: c.into(), reason: Default::default() })))
                            .unwrap_or(Message::Close(None));
                        let _ = sink.send(frame).await;
                        let _ = sink.close().await;
                        break;
                    }
                    None => break,
                }
            }
        }
    }
}

#[tauri::command]
pub async fn ws_send(
    state: tauri::State<'_, WsState>,
    id: u32,
    text: String,
) -> Result<(), String> {
    let tx = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.get(&id).cloned())
        .ok_or_else(|| "This connection is closed.".to_string())?;
    tx.send(WsCommand::Send(Message::Text(text)))
        .await
        .map_err(|_| "This connection is closed.".to_string())
}

#[tauri::command]
pub async fn ws_close(state: tauri::State<'_, WsState>, id: u32, code: Option<u16>) -> Result<(), String> {
    let tx = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.get(&id).cloned())
        .ok_or_else(|| "Already closed.".to_string())?;
    tx.send(WsCommand::Close(code))
        .await
        .map_err(|_| "Already closed.".to_string())
}