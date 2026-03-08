use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use axum::{
    extract::Query,
    response::{IntoResponse, Response},
    http::{HeaderMap, StatusCode},
    routing::get,
    Router,
};

const PROXY_PORT: u16 = 9999;
const PROXY_BASE: &str = "http://127.0.0.1:9999/proxy?url=";

// ── PTY session store ─────────────────────────────────────────────────────────

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

type SessionMap = Arc<Mutex<HashMap<String, PtySession>>>;

struct AppState {
    sessions: SessionMap,
}

// ── URL rewriting helpers ─────────────────────────────────────────────────────

/// Resolve a possibly-relative URL against the page base URL.
fn resolve_url(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    if href.starts_with("//") {
        let scheme = if base.starts_with("https") { "https:" } else { "http:" };
        return format!("{}{}", scheme, href);
    }
    if let Some(idx) = base.find("://") {
        let after = &base[idx + 3..];
        let origin_end = after.find('/').map(|i| idx + 3 + i).unwrap_or(base.len());
        let origin = &base[..origin_end];
        if href.starts_with('/') {
            return format!("{}{}", origin, href);
        } else {
            let path = &base[..base.rfind('/').unwrap_or(base.len())];
            return format!("{}/{}", path, href);
        }
    }
    href.to_string()
}

/// Rewrite all asset URLs in HTML/CSS to route through the proxy.
fn rewrite_urls(body: &str, base_url: &str) -> String {
    let mut out = body.to_string();

    // Rewrite href="..." src="..." action="..."
    for attr in &["src", "href", "action"] {
        let mut result = String::new();
        let mut remaining = out.as_str();
        let pattern = format!("{}=\"", attr);
        while let Some(start) = remaining.find(&pattern) {
            result.push_str(&remaining[..start + pattern.len()]);
            remaining = &remaining[start + pattern.len()..];
            if let Some(end) = remaining.find('"') {
                let original = &remaining[..end];
                if original.starts_with('#')
                    || original.starts_with("data:")
                    || original.starts_with("mailto:")
                    || original.starts_with("javascript:")
                    || original.is_empty()
                {
                    result.push_str(original);
                } else {
                    let resolved = resolve_url(base_url, original);
                    result.push_str(&format!(
                        "{}{}",
                        PROXY_BASE,
                        urlencoding::encode(&resolved)
                    ));
                }
                remaining = &remaining[end..];
            }
        }
        result.push_str(remaining);
        out = result;
    }

    // Rewrite url('...') / url("...") in inline CSS
    let mut result = String::new();
    let mut remaining = out.as_str();
    while let Some(start) = remaining.find("url(") {
        result.push_str(&remaining[..start + 4]);
        remaining = &remaining[start + 4..];
        let (quote, skip) = if remaining.starts_with('"') {
            ('"', 1usize)
        } else if remaining.starts_with('\'') {
            ('\'', 1usize)
        } else {
            ('\0', 0usize)
        };
        let search_from = &remaining[skip..];
        let end_char = if quote == '\0' { ')' } else { quote };
        if let Some(end) = search_from.find(end_char) {
            let original = &search_from[..end];
            if !original.starts_with("data:") && !original.is_empty() {
                let resolved = resolve_url(base_url, original);
                if skip > 0 { result.push(quote); }
                result.push_str(&format!(
                    "{}{}",
                    PROXY_BASE,
                    urlencoding::encode(&resolved)
                ));
                if skip > 0 { result.push(quote); }
            } else {
                if skip > 0 { result.push(quote); }
                result.push_str(original);
                if skip > 0 { result.push(quote); }
            }
            remaining = &search_from[end + skip..];
        }
    }
    result.push_str(remaining);
    out = result;

    // Inject <base> tag as a fallback for any URLs we missed
    let base_tag = format!(
        "<base href=\"{}{}\">",
        PROXY_BASE,
        urlencoding::encode(base_url)
    );
    if let Some(pos) = out.find("</head>") {
        out.insert_str(pos, &base_tag);
    } else if let Some(html_start) = out.find("<html") {
        if let Some(tag_end) = out[html_start..].find('>') {
            out.insert_str(
                html_start + tag_end + 1,
                &format!("<head>{}</head>", base_tag),
            );
        }
    }

    out
}

// ── Proxy handler ─────────────────────────────────────────────────────────────

async fn proxy_handler(Query(params): Query<HashMap<String, String>>) -> Response {
    let url = match params.get("url") {
        Some(u) => u.clone(),
        None => return (StatusCode::BAD_REQUEST, "missing url param").into_response(),
    };

    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
    {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let resp = match client.get(&url).send().await {
        Ok(r)  => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("proxy error: {}", e)).into_response(),
    };

    let status = resp.status();
    let mut headers = HeaderMap::new();
    let mut content_type = String::from("text/html");

    for (k, v) in resp.headers() {
        let key = k.as_str().to_lowercase();
        match key.as_str() {
            // Strip headers that block iframe embedding
            "x-frame-options" | "content-security-policy" |
            "x-content-type-options" | "transfer-encoding" => {}
            "content-type" => {
                content_type = v.to_str().unwrap_or("text/html").to_string();
                headers.insert(k.clone(), v.clone());
            }
            _ => { let _ = headers.insert(k.clone(), v.clone()); }
        }
    }

    let body_bytes = resp.bytes().await.unwrap_or_default();
    let is_html = content_type.contains("html");
    let is_css  = content_type.contains("css");

    if is_html || is_css {
        // Rewrite URLs so CSS/images/scripts load through the proxy
        let text = String::from_utf8_lossy(&body_bytes).into_owned();
        let rewritten = rewrite_urls(&text, &url);
        (status, headers, rewritten.into_bytes()).into_response()
    } else {
        // Binary assets (images, fonts, js) — pass through unchanged
        (status, headers, body_bytes.to_vec()).into_response()
    }
}

// ── Start proxy on its own thread with its own tokio runtime ──────────────────

fn start_proxy_server() {
    std::thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new()
            .expect("failed to create proxy tokio runtime");
        rt.block_on(async {
            let router = Router::new().route("/proxy", get(proxy_handler));
            let addr   = format!("127.0.0.1:{}", PROXY_PORT);
            let listener = tokio::net::TcpListener::bind(&addr).await
                .expect("failed to bind proxy server");
            println!("[proxy] listening on http://{}", addr);
            axum::serve(listener, router).await
                .expect("proxy server crashed");
        });
    });
}

// ── Helper: Windows shell ─────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
fn windows_shell() -> CommandBuilder {
    let pwsh = std::process::Command::new("where")
        .args(["pwsh.exe"])
        .output()
        .ok()
        .filter(|o| o.status.success());

    let (exe, args): (&str, &[&str]) = if pwsh.is_some() {
        ("pwsh.exe",       &["-NoLogo", "-NoExit"])
    } else {
        ("powershell.exe", &["-NoLogo", "-NoExit"])
    };

    let mut c = CommandBuilder::new(exe);
    for a in args { c.arg(a); }
    c
}

// ── PTY Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    session_id: String,
    cwd: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let resolved_cwd = {
        let expanded = shellexpand::tilde(&cwd).into_owned();
        let p = std::path::PathBuf::from(&expanded);
        if p.exists() { p } else {
            dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
        }
    };

    #[cfg(target_os = "windows")]
    let mut cmd = windows_shell();

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut c = CommandBuilder::new(&shell);
        c.arg("--login");
        c
    };

    cmd.cwd(&resolved_cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    #[cfg(target_os = "windows")]
    {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy().into_owned();
            cmd.env("HOME", &home_str);
            cmd.env("USERPROFILE", &home_str);
        }
    }

    let child  = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut map = state.sessions.lock().unwrap();
        map.insert(session_id.clone(), PtySession {
            writer,
            master: pair.master,
            _child: child,
        });
    }

    let sid  = session_id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app2.emit(&format!("pty://ended/{}", sid), ());
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app2.emit(&format!("pty://output/{}", sid), text);
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn pty_write(
    session_id: String,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    if let Some(session) = map.get_mut(&session_id) {
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Session '{}' not found", session_id))
    }
}

#[tauri::command]
fn pty_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    if let Some(session) = map.get(&session_id) {
        session.master.resize(PtySize {
            rows, cols, pixel_width: 0, pixel_height: 0,
        }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(session_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    map.remove(&session_id);
    Ok(())
}


// ── Browser overlay commands ──────────────────────────────────────────────────
// Instead of an iframe proxy, we create a real native WebviewWindow
// positioned exactly over the browser pane div in the frontend.
// The frontend reports x/y/w/h from getBoundingClientRect() and we
// position/resize the webview to match perfectly.

#[tauri::command]
fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64, y: f64, w: f64, h: f64,
) -> Result<(), String> {
    let full_url = if url.starts_with("http://") || url.starts_with("https://") {
        url.clone()
    } else {
        format!("https://{}", url)
    };
    let parsed: tauri::Url = full_url.parse()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    // If window already exists, navigate and reposition it
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.navigate(parsed);
        let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
        let _ = win.show();
        return Ok(());
    }

    // Create new frameless webview window overlaid on the pane
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title("")
        .decorations(false)
        .resizable(false)
        .always_on_top(false)
        .position(x, y)
        .inner_size(w, h)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let full_url = if url.starts_with("http://") || url.starts_with("https://") {
        url.clone()
    } else {
        format!("https://{}", url)
    };
    let parsed: tauri::Url = full_url.parse()
        .map_err(|e| format!("Invalid URL: {}", e))?;
    if let Some(win) = app.get_webview_window(&label) {
        win.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_move(
    app: AppHandle,
    label: String,
    x: f64, y: f64, w: f64, h: f64,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    }
    Ok(())
}

#[tauri::command]
fn browser_show(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) { let _ = win.show(); }
    Ok(())
}

#[tauri::command]
fn browser_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) { let _ = win.hide(); }
    Ok(())
}

#[tauri::command]
fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) { let _ = win.close(); }
    Ok(())
}

#[tauri::command]
fn browser_back(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.eval("window.history.back()");
    }
    Ok(())
}

#[tauri::command]
fn browser_forward(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.eval("window.history.forward()");
    }
    Ok(())
}

#[tauri::command]
fn browser_reload(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.eval("window.location.reload()");
    }
    Ok(())
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start proxy BEFORE Tauri — has its own runtime, no conflict
    start_proxy_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            browser_open,
            browser_navigate,
            browser_move,
            browser_show,
            browser_hide,
            browser_close,
            browser_back,
            browser_forward,
            browser_reload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}