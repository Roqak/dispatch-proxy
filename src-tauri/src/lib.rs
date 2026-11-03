mod ai;
mod cookies;
mod folders;
mod grpc;
mod http;
mod loadtest;
mod mock;
mod postman;
mod secrets;
mod ws;

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_name(name: &str) -> Result<&str, String> {
    if !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(name)
    } else {
        Err("Invalid store name".into())
    }
}

// ---------- HTTP ----------

#[tauri::command]
async fn send_request(
    state: State<'_, http::HttpState>,
    request: http::OutgoingRequest,
) -> Result<http::IncomingResponse, String> {
    http::send(&state, request).await
}

/// Sends a request; streaming responses (SSE, NDJSON) are relayed live on `on_event`.
#[tauri::command]
async fn send_request_stream(
    state: State<'_, http::HttpState>,
    request: http::OutgoingRequest,
    id: String,
    on_event: tauri::ipc::Channel<http::StreamEvent>,
) -> Result<http::IncomingResponse, String> {
    let cancel: std::sync::Arc<tokio::sync::Notify> = Default::default();
    state.streams.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), cancel.clone());
    let sink = http::StreamSink { on_event: Box::new(move |e| { let _ = on_event.send(e); }), cancel };
    let out = http::send_with(&state, request, Some(&sink)).await;
    state.streams.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    out
}

/// Stops a streaming response started with send_request_stream.
#[tauri::command]
fn stop_request(state: State<'_, http::HttpState>, id: String) -> bool {
    match state.streams.lock().unwrap_or_else(|p| p.into_inner()).get(&id) {
        Some(n) => { n.notify_one(); true }
        None => false,
    }
}

#[tauri::command]
fn clear_cookies(state: State<'_, http::HttpState>) {
    state.jar.clear();
}

#[tauri::command]
fn list_cookies(state: State<'_, http::HttpState>) -> Vec<cookies::CookieInfo> {
    state.jar.list()
}

#[tauri::command]
fn set_cookie(state: State<'_, http::HttpState>, cookie: cookies::CookieInput) -> Result<(), String> {
    state.jar.set(cookie)
}

#[tauri::command]
fn delete_cookie(state: State<'_, http::HttpState>, domain: String, path: String, name: String) -> bool {
    state.jar.delete(&domain, &path, &name)
}

// ---------- AI assistant ----------

/// Verifies the Anthropic API key, then keeps it in the keychain.
#[tauri::command]
async fn ai_set_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    ai::verify_key(&key).await?;
    secrets::store_set(&data_dir(&app)?, ai::KEY_SLOT, &key)
}

#[tauri::command]
fn ai_has_key(app: AppHandle) -> Result<bool, String> {
    Ok(secrets::store_get(&data_dir(&app)?, ai::KEY_SLOT)?.is_some_and(|k| !k.is_empty()))
}

#[tauri::command]
fn ai_delete_key(app: AppHandle) -> Result<(), String> {
    secrets::store_set(&data_dir(&app)?, ai::KEY_SLOT, "")
}

/// Asks Claude; text streams on `on_event`. Stop it with stop_request(id).
#[tauri::command]
async fn ai_ask(
    app: AppHandle,
    state: State<'_, http::HttpState>,
    request: ai::Ask,
    id: String,
    on_event: tauri::ipc::Channel<ai::AiEvent>,
) -> Result<ai::Answer, String> {
    let key = secrets::store_get(&data_dir(&app)?, ai::KEY_SLOT)?.filter(|k| !k.is_empty())
        .ok_or_else(|| "Add your Anthropic API key under Settings → AI assistant first.".to_string())?;
    let cancel: std::sync::Arc<tokio::sync::Notify> = Default::default();
    state.streams.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), cancel.clone());
    let out = ai::ask(&key, request, cancel, move |e| { let _ = on_event.send(e); }).await;
    state.streams.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    out
}

// ---------- gRPC ----------

#[tauri::command]
async fn grpc_describe(state: State<'_, grpc::GrpcState>, source: grpc::Source) -> Result<Vec<grpc::ServiceInfo>, String> {
    state.describe(&source).await
}

#[tauri::command]
async fn grpc_call(
    state: State<'_, grpc::GrpcState>,
    source: grpc::Source,
    method: String,
    message: String,
    on_message: tauri::ipc::Channel<String>,
) -> Result<grpc::CallResult, String> {
    state.call(&source, &method, &message, move |m| { let _ = on_message.send(m); }).await
}

/// Lets the user pick .proto files for a gRPC request.
#[tauri::command]
async fn pick_proto_files(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = app.dialog().file().add_filter("Protocol Buffers", &["proto"]).blocking_pick_files().unwrap_or_default();
    picked.into_iter().map(|f| f.into_path().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string())).collect()
}

// ---------- Load tests ----------

#[tauri::command]
async fn loadtest_run(
    tests: State<'_, loadtest::LoadTests>,
    id: String,
    request: http::OutgoingRequest,
    config: loadtest::Config,
    on_progress: tauri::ipc::Channel<loadtest::Report>,
) -> Result<loadtest::Report, String> {
    tests.run(id, request, config, move |r| { let _ = on_progress.send(r); }).await
}

#[tauri::command]
fn loadtest_stop(tests: State<'_, loadtest::LoadTests>, id: String) -> bool {
    tests.stop(&id)
}

// ---------- Mock servers ----------

#[tauri::command]
async fn mock_start(
    mocks: State<'_, mock::Mocks>,
    id: String,
    port: u16,
    routes: Vec<mock::Route>,
    on_log: tauri::ipc::Channel<mock::LogEntry>,
) -> Result<u16, String> {
    mocks.start(id, port, routes, std::sync::Arc::new(move |e| { let _ = on_log.send(e); })).await
}

#[tauri::command]
fn mock_update(mocks: State<'_, mock::Mocks>, id: String, routes: Vec<mock::Route>) -> bool {
    mocks.update(&id, routes)
}

#[tauri::command]
fn mock_stop(mocks: State<'_, mock::Mocks>, id: String) -> bool {
    mocks.stop(&id)
}

#[tauri::command]
fn mock_list(mocks: State<'_, mock::Mocks>) -> Vec<(String, u16)> {
    mocks.list()
}

// ---------- Collections as folders (Git) ----------

/// Shows the folder picker; the chosen folder becomes writable for folder_write.
#[tauri::command]
async fn pick_folder(app: AppHandle, folders: State<'_, folders::Folders>) -> Result<Option<String>, String> {
    let Some(fp) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    Ok(Some(folders.allow(&path)?.to_string_lossy().to_string()))
}

#[tauri::command]
fn folder_read(folders: State<'_, folders::Folders>, dir: String) -> Result<Vec<folders::FileEntry>, String> {
    folders.read(&dir)
}

#[tauri::command]
fn folder_write(folders: State<'_, folders::Folders>, dir: String, files: Vec<folders::FileEntry>, prune: bool) -> Result<usize, String> {
    folders.write(&dir, &files, prune)
}

#[tauri::command]
fn folder_forget(folders: State<'_, folders::Folders>, dir: String) {
    folders.forget(&dir)
}

// ---------- Postman ----------

#[tauri::command]
async fn postman_api(
    app: AppHandle,
    profile_id: String,
    method: String,
    path: String,
    body: Option<Value>,
    region: Option<String>,
    server: Option<bool>,
    base_url: Option<String>,
) -> Result<Value, String> {
    let profile_id = safe_name(&profile_id)?;
    let secret = secrets::get(&data_dir(&app)?, profile_id)?;
    let target = if server.unwrap_or(false) {
        postman::Target::Server {
            base_url: postman::server_base(base_url.as_deref().unwrap_or(""))?,
            token: secret.ok_or_else(|| "This profile isn't signed in to your Dispatch server. Sign in again under Settings → Profiles.".to_string())?,
        }
    } else {
        postman::Target::Postman {
            api_key: secret.ok_or_else(|| "This profile has no Postman API key. Add it under Settings → Profiles.".to_string())?,
            region: region.unwrap_or_else(|| "us".into()),
        }
    };
    postman::call(&target, &method, &path, body).await
}

/// Sign a Dispatch server profile in: email+password login, or verify a
/// pre-issued token. Stores the token as the profile's secret and returns /me.
#[tauri::command]
async fn server_auth(
    app: AppHandle,
    profile_id: String,
    base_url: String,
    email: Option<String>,
    password: Option<String>,
    token: Option<String>,
) -> Result<Value, String> {
    let profile_id = safe_name(&profile_id)?.to_string();
    let base = postman::server_base(&base_url)?;
    let need_creds = "Enter your email and password, or paste a token".to_string();
    let token = match token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => {
            let email = email.as_deref().map(str::trim).filter(|e| !e.is_empty()).ok_or_else(|| need_creds.clone())?;
            let password = password.as_deref().filter(|p| !p.is_empty()).ok_or_else(|| need_creds.clone())?;
            postman::server_login(&base, email, password).await?
        }
    };
    // /me doubles as a check that the token is accepted before it's stored.
    let me = postman::call(&postman::Target::Server { base_url: base.clone(), token: token.clone() }, "GET", "/me", None).await?;
    secrets::set(&data_dir(&app)?, &profile_id, &token)?;
    Ok(me)
}

#[tauri::command]
async fn set_api_key(app: AppHandle, profile_id: String, key: String, region: Option<String>) -> Result<Value, String> {
    let profile_id = safe_name(&profile_id)?.to_string();
    let key = key.trim().to_string();
    // Verify before saving so a typo doesn't get stored.
    let target = postman::Target::Postman { api_key: key.clone(), region: region.as_deref().unwrap_or("us").to_string() };
    let me = postman::call(&target, "GET", "/me", None).await?;
    secrets::set(&data_dir(&app)?, &profile_id, &key)?;
    Ok(me)
}

#[tauri::command]
fn has_api_key(app: AppHandle, profile_id: String) -> Result<bool, String> {
    Ok(secrets::get(&data_dir(&app)?, safe_name(&profile_id)?)?.is_some())
}

#[tauri::command]
fn delete_api_key(app: AppHandle, profile_id: String) -> Result<(), String> {
    secrets::delete(&data_dir(&app)?, safe_name(&profile_id)?)
}

#[tauri::command]
fn has_legacy_api_key(app: AppHandle) -> Result<bool, String> {
    Ok(secrets::legacy_has(&data_dir(&app)?))
}

/// Copies the pre-profiles single key into a named profile.
#[tauri::command]
fn migrate_legacy_key(app: AppHandle, profile_id: String) -> Result<bool, String> {
    secrets::legacy_copy_value(&data_dir(&app)?, safe_name(&profile_id)?)
}

/// Releases freed-but-retained arena memory (call after tabs close).
/// glibc-specific; other platforms' allocators trim themselves.
#[tauri::command]
fn trim_memory(app: AppHandle) -> bool {
    let _ = &app;
    #[cfg(target_os = "linux")]
    unsafe { libc::malloc_trim(0) != 0 }
    #[cfg(not(target_os = "linux"))]
    false
}

/// Opens the auth URL in a child window and resolves when navigation reaches
/// `redirectPrefix` with `?code=...` (or `#code=`). Returns the redirect URL.
#[tauri::command]
async fn oauth_authorization_flow(app: AppHandle, auth_url: String, redirect_prefix: String) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let handle = app.clone();
    let redirect_prefix = redirect_prefix.clone();
    std::thread::spawn(move || {
      let built = (|| -> Result<tauri::WebviewWindow, String> {
        let url: tauri::Url = auth_url.parse().map_err(|e| format!("Bad auth URL: {e}"))?;
        tauri::WebviewWindowBuilder::new(&handle, "oauth", tauri::WebviewUrl::External(url))
          .title("Sign in")
          .inner_size(560.0, 640.0)
          .build()
          .map_err(|e| format!("Couldn't open the sign-in window: {e}"))
      })();
      let child = match built {
        Ok(c) => c,
        Err(e) => { let _ = tx.send(Err(e)); return; }
      };
      let _ = tx.send(Err("pending".to_string()));
      // Poll navigation; tauri's on_navigation doesn't exist on the builder here,
      // so the window writes its URL to an event the main window relays via eval.
      let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
      loop {
        if std::time::Instant::now() > deadline { let _ = tx.send(Err("Sign-in timed out after 5 minutes.".into())); break; }
        if let Ok(url) = child.url() {
          let s = url.as_str();
          if s.starts_with(&redirect_prefix) {
            let _ = child.close();
            let _ = tx.send(Ok(s.to_string()));
            break;
          }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
      }
    });
    // The loop above sends "pending" first, then the final result — take the LAST one.
    match rx.recv() {
        Ok(Err(p)) if p == "pending" => match rx.recv() { Ok(outcome) => outcome, Err(_) => Err("Sign-in window closed.".into()) },
        Ok(r) => r,
        Err(_) => Err("Sign-in window closed.".into()),
    }
}

// ---------- Generic secret slots (e.g. client-certificate passwords) ----------

#[tauri::command]
fn secret_get(app: AppHandle, key: String) -> Result<String, String> {
    Ok(secrets::store_get(&data_dir(&app)?, safe_name(&key)?)?.unwrap_or_default())
}

/// Empty value deletes the slot.
#[tauri::command]
fn secret_put(app: AppHandle, key: String, value: String) -> Result<(), String> {
    secrets::store_set(&data_dir(&app)?, safe_name(&key)?, &value)
}

// ---------- Local storage (cache, history, settings) ----------

#[tauri::command]
fn store_read(app: AppHandle, name: String) -> Result<Value, String> {
    let path = data_dir(&app)?.join(format!("{}.json", safe_name(&name)?));
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{name} is corrupted: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn store_write(app: AppHandle, name: String, value: Value) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let name = safe_name(&name)?;
    let tmp = dir.join(format!("{name}.json.tmp"));
    let path = dir.join(format!("{name}.json"));
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- Files (import/export, form-data file picking) ----------

#[tauri::command]
async fn open_text_file(app: AppHandle) -> Result<Option<Value>, String> {
    let picked = app.dialog().file().add_filter("Collections and API specs", &["json", "yaml", "yml", "har"]).blocking_pick_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    Ok(Some(serde_json::json!({ "path": path.to_string_lossy(), "content": content })))
}

#[tauri::command]
async fn pick_file_path(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_file();
    match picked {
        Some(fp) => Ok(Some(fp.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
async fn save_text_file(app: AppHandle, default_name: String, content: String) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_file_name(&default_name).add_filter("JSON", &["json"]).blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn save_binary_file(app: AppHandle, default_name: String, base64_content: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64_content).map_err(|e| e.to_string())?;
    let picked = app.dialog().file().set_file_name(&default_name).blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, bytes).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(http::HttpState::new())
        .manage(mock::Mocks::default())
        .manage(loadtest::LoadTests::default())
        .manage(grpc::GrpcState::default())
        .manage(folders::Folders::default())
        .manage(ws::new())
        .invoke_handler(tauri::generate_handler![
            send_request,
            send_request_stream,
            stop_request,
            clear_cookies,
            list_cookies,
            set_cookie,
            delete_cookie,
            ai_set_key,
            ai_has_key,
            ai_delete_key,
            ai_ask,
            grpc_describe,
            grpc_call,
            pick_proto_files,
            loadtest_run,
            loadtest_stop,
            mock_start,
            mock_update,
            mock_stop,
            mock_list,
            pick_folder,
            folder_read,
            folder_write,
            folder_forget,
            postman_api,
            set_api_key,
            server_auth,
            has_api_key,
            delete_api_key,
            has_legacy_api_key,
            migrate_legacy_key,
            secret_get,
            secret_put,
            trim_memory,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            oauth_authorization_flow,
            store_read,
            store_write,
            open_text_file,
            pick_file_path,
            save_text_file,
            save_binary_file,
        ])
        .setup(|app| {
            // Persistent cookies live next to the rest of the app data.
            if let Ok(dir) = data_dir(app.handle()) {
                app.state::<http::HttpState>().jar.attach(dir.join("cookies.json"));
                app.state::<folders::Folders>().attach(dir.join("linked-folders.json"));
            }
            // Optional evaluator endpoint for benchmarking the real UI:
            // DISPATCH_TEST_HOOK=9944 runs a local-only HTTP server whose POST
            // body is evaluated as JavaScript inside the main webview.
            if let Some(Ok(port)) = std::env::var("DISPATCH_TEST_HOOK").ok().map(|v| v.parse::<u16>()) {
                let handle = app.handle().clone();
                std::thread::spawn(move || test_hook::serve(handle, port));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dispatch");
}

mod test_hook {
    //! Benchmark-only: evaluates JS in the webview on request.
    use std::io::{Read, Write};
    use tauri::Manager;

    pub fn serve(app: tauri::AppHandle, port: u16) {
        let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(_) => return,
        };
        for mut stream in listener.incoming().flatten() {
            let mut buf = [0u8; 65536];
            let n = stream.read(&mut buf).unwrap_or(0);
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            let request_line = text.lines().next().unwrap_or("");
            let body = match text.split_once("\r\n\r\n") {
                Some((headers, rest)) => {
                    let len = headers
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if len > 0 { rest.as_bytes().get(..len.min(rest.len())).and_then(|s| std::str::from_utf8(s).ok()) } else { Some(rest) }
                }
                None => None,
            };
            let body = match body {
                Some(b) => b.to_string(),
                None => { let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); continue; }
            };
            // /trim releases freed-but-retained arena memory (benchmark/drain aid).
            if request_line.starts_with("POST /trim") {
                #[cfg(target_os = "linux")]
                {
                    let freed = unsafe { libc::malloc_trim(0) };
                    let msg = format!("trimmed={freed}");
                    let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", msg.len()).as_bytes())
                        .and_then(|_| stream.write_all(msg.as_bytes()));
                }
                #[cfg(not(target_os = "linux"))]
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\ntrimmed=0");
                continue;
            }
            // Page → bench result channel: POST /out appends the body to a file.
            if request_line.starts_with("POST /out") && !body.is_empty() {
                let _ = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/dispatch-hook-out").and_then(|mut f| writeln!(f, "{}", body));
                let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            let app2 = app.clone();
            let js = body.clone();
            let respond = move || {
                match app2.get_webview_window("main") {
                    Some(w) => {
                        let r = w.eval(&js);
                        let msg: &[u8] = if r.is_ok() { b"ok" } else { b"eval failed" };
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n").and_then(|_| stream.write_all(msg));
                    }
                    None => {
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nno webview");
                    }
                }
            };
            // eval must run on the main thread
            let _ = app.run_on_main_thread(respond);
        }
    }
}
