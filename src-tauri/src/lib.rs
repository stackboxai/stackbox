mod browser;
mod db;
mod memory;
mod git_memory;

use browser::{
    browser_create, browser_destroy, browser_navigate, browser_set_bounds,
    browser_go_back, browser_go_forward, browser_reload, browser_show, browser_hide,
};

use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri::http::{Request, Response};

// ── CWD expansion ─────────────────────────────────────────────────────────────
fn expand_cwd(raw: &str) -> String {
    let s = raw.trim();
    let expanded = if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            let rest = s[1..].trim_start_matches('/').trim_start_matches('\\');
            if rest.is_empty() { home.to_string_lossy().to_string() }
            else { home.join(rest).to_string_lossy().to_string() }
        } else { s.to_string() }
    } else { s.to_string() };

    #[cfg(windows)]
    if expanded.contains('%') {
        if let Ok(v) = std::env::var("USERPROFILE") {
            return expanded.replace("%USERPROFILE%", &v).replace("%userprofile%", &v);
        }
    }
    expanded
}

// ── Proxy scheme ──────────────────────────────────────────────────────────────
const PROXY_BASE: &str = "proxy://localhost/fetch?url=";

fn resolve_url(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") { return href.to_string(); }
    if href.starts_with("//") {
        let scheme = if base.starts_with("https") { "https:" } else { "http:" };
        return format!("{}{}", scheme, href);
    }
    if let Some(idx) = base.find("://") {
        let after = &base[idx + 3..];
        let origin_end = after.find('/').map(|i| idx + 3 + i).unwrap_or(base.len());
        let origin = &base[..origin_end];
        if href.starts_with('/') { return format!("{}{}", origin, href); }
        let path = &base[..base.rfind('/').unwrap_or(base.len())];
        return format!("{}/{}", path, href);
    }
    href.to_string()
}

fn rewrite_urls(body: &str, base_url: &str) -> String {
    let mut out = body.to_string();
    for attr in &["src", "href", "action"] {
        let mut result = String::new();
        let mut remaining = out.as_str();
        let pattern = format!("{}=\"", attr);
        while let Some(start) = remaining.find(&pattern) {
            result.push_str(&remaining[..start + pattern.len()]);
            remaining = &remaining[start + pattern.len()..];
            if let Some(end) = remaining.find('"') {
                let original = &remaining[..end];
                if original.starts_with('#') || original.starts_with("data:") || original.is_empty() {
                    result.push_str(original);
                } else {
                    let resolved = resolve_url(base_url, original);
                    result.push_str(&format!("{}{}", PROXY_BASE, urlencoding::encode(&resolved)));
                }
                remaining = &remaining[end..];
            }
        }
        result.push_str(remaining);
        out = result;
    }
    let base_tag = format!("<base href=\"{}{}\">", PROXY_BASE, urlencoding::encode(base_url));
    let form_shim = format!(r#"<script>
    (function() {{
        const PROXY = {:?};
        document.addEventListener('submit', function(e) {{
            const f = e.target;
            if (!f || f.method.toUpperCase() !== 'GET') return;
            e.preventDefault();
            const fd = new FormData(f);
            const qs = new URLSearchParams(fd).toString();
            const base = f.action || window.location.href;
            window.location.href = PROXY + encodeURIComponent(base.split('?')[0] + '?' + qs);
        }}, true);
    }})();
    </script>"#, PROXY_BASE);
    if let Some(pos) = out.find("</head>") {
        out.insert_str(pos, &(base_tag + &form_shim));
    }
    out
}

fn handle_proxy_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let url = if let Some(pos) = uri.find("?url=") {
        urlencoding::decode(&uri[pos + 5..]).unwrap_or_default().into_owned()
    } else {
        return Response::builder().status(400).body(b"missing url param".to_vec()).unwrap();
    };

    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .cookie_store(true)
            .build()
            .unwrap_or_default();

        let resp: reqwest::Response = match client.get(&url).send().await {
            Ok(r)  => r,
            Err(e) => return Response::builder().status(502).body(e.to_string().into_bytes()).unwrap(),
        };

        let status = resp.status().as_u16();
        let mut is_html = false;
        let mut content_type = String::from("application/octet-stream");
        for (k, v) in resp.headers() {
            if k.as_str().to_lowercase() == "content-type" {
                let ct = v.to_str().unwrap_or("").to_string();
                if ct.contains("text/html") { is_html = true; }
                content_type = ct;
            }
        }
        let body_bytes = resp.bytes().await.unwrap_or_default();
        let final_body = if is_html {
            rewrite_urls(&String::from_utf8_lossy(&body_bytes), &url).into_bytes()
        } else {
            body_bytes.to_vec()
        };
        Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .body(final_body)
            .unwrap()
    })
}

// ── PTY session ───────────────────────────────────────────────────────────────
struct PtySession {
    writer:    Box<dyn Write + Send>,
    _master:   Box<dyn portable_pty::MasterPty + Send>,
    _child:    Box<dyn portable_pty::Child + Send + Sync>,
    input_buf: String,
    runbox_id: String,
    cwd:       String,
}

type SessionMap = Arc<Mutex<HashMap<String, PtySession>>>;

// ── Watcher handle — keeps the debouncer alive ────────────────────────────────
type WatcherMap = Arc<Mutex<HashMap<String, notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>>;

struct AppState {
    sessions: SessionMap,
    db:       db::Db,
    watchers: WatcherMap,
}

// ── PTY commands ──────────────────────────────────────────────────────────────
#[tauri::command]
async fn pty_spawn(
    app:        AppHandle,
    session_id: String,
    runbox_id:  String,
    cwd:        String,
    agent_cmd:  Option<String>,
    state:      tauri::State<'_, AppState>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let resolved_cwd = expand_cwd(&cwd);
    let agent_str    = agent_cmd.as_deref().unwrap_or("shell");
    let agent_kind   = git_memory::AgentKind::detect(agent_str);

    // ── Ensure git repo exists ────────────────────────────────────────────
    git_memory::ensure_git_repo(&resolved_cwd, &runbox_id)
        .unwrap_or_else(|e| { eprintln!("[git_memory] ensure_git_repo: {e}"); String::new() });

    // ── Record session-start event ────────────────────────────────────────
    let _ = db::event_insert(
        &state.db,
        &runbox_id,
        &session_id,
        "session_start",
        &format!("Agent {:?} started in {}", agent_kind, resolved_cwd),
        None,
    );

    // ── Inject memories + git log non-blocking ────────────────────────────
    {
        let rb    = runbox_id.clone();
        let cwd_c = resolved_cwd.clone();
        let ak    = agent_kind.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = git_memory::inject_context_for_agent(&rb, &cwd_c, &ak).await {
                eprintln!("[git_memory] inject: {e}");
            }
        });
    }

    // ── Shell command ─────────────────────────────────────────────────────
    #[cfg(windows)]
    let mut cmd = {
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let ps_path  = format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", sys_root);
        let mut c = CommandBuilder::new(&ps_path);
        c.args(&[
            "-NoLogo", "-NoExit", "-NonInteractive", "-Command",
            r#"function prompt { "~/\" + (Split-Path -Leaf (Get-Location)) + "> " }"#,
        ]);
        c.env("SystemRoot",   &sys_root);
        c.env("USERPROFILE",  std::env::var("USERPROFILE").unwrap_or_default());
        c.env("APPDATA",      std::env::var("APPDATA").unwrap_or_default());
        c.env("LOCALAPPDATA", std::env::var("LOCALAPPDATA").unwrap_or_default());
        c.env("TEMP",         std::env::var("TEMP").unwrap_or_default());
        c.env("TMP",          std::env::var("TMP").unwrap_or_default());
        c.env("PATH",         std::env::var("PATH").unwrap_or_default());
        c
    };

    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new("bash");

    cmd.cwd(&resolved_cwd);

    // ── Browser shim ──────────────────────────────────────────────────────
    if let Some(shim_path) = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.join("stackbox-open.exe")))
        .filter(|p| p.exists())
    {
        cmd.env("BROWSER", shim_path.to_string_lossy().to_string());
    }

    // ── API key passthrough ───────────────────────────────────────────────
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        cmd.env("ANTHROPIC_API_KEY", key);
    }

    // ── Agent env vars ────────────────────────────────────────────────────
    let ctx_file = format!("{resolved_cwd}/.stackbox-context.md");
    cmd.env("STACKBOX_CONTEXT_FILE", &ctx_file);
    cmd.env("STACKBOX_MEMORY_URL", format!("http://localhost:{}/memory", git_memory::MEMORY_PORT));
    cmd.env("STACKBOX_RUNBOX_ID", &runbox_id);

    match &agent_kind {
        git_memory::AgentKind::ClaudeCode    => { cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"); }
        git_memory::AgentKind::Codex         => { cmd.env("CODEX_CONTEXT_FILE", &ctx_file); }
        git_memory::AgentKind::CursorAgent   => { cmd.env("CURSOR_CONTEXT_FILE", &ctx_file); }
        git_memory::AgentKind::GeminiCli     => { cmd.env("GEMINI_SYSTEM_MD", &ctx_file); }
        git_memory::AgentKind::GitHubCopilot => { cmd.env("COPILOT_CONTEXT_FILE", &ctx_file); }
        git_memory::AgentKind::OpenCode      => { cmd.env("OPENCODE_CONTEXT_FILE", &ctx_file); }
        git_memory::AgentKind::Shell         => {}
    }

    let child  = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer     = pair.master.take_writer().map_err(|e| e.to_string())?;

    // ── Auto-launch agent after bash spawns ───────────────────────────────
    if let Some(launch) = agent_kind.launch_cmd_for(&ctx_file) {
        if let Ok(mut w) = pair.master.take_writer() {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let _ = w.write_all(launch.as_bytes());
                let _ = w.flush();
            });
        }
    }

    // ── Record session in DB ──────────────────────────────────────────────
    let _ = db::session_start(
        &state.db, &session_id, &runbox_id,
        &session_id, agent_str, &resolved_cwd,
    );

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        PtySession {
            writer,
            _master:   pair.master,
            _child:    child,
            input_buf: String::new(),
            runbox_id: runbox_id.clone(),
            cwd:       resolved_cwd.clone(),
        },
    );

    // ── PTY reader thread ─────────────────────────────────────────────────
    let sid              = session_id.clone();
    let rb_id            = runbox_id.clone();
    let app_pty          = app.clone();
    let db_arc           = state.db.clone();
    let agent_kind_clone = agent_kind.clone();
    let session_start_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];

        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            let text = String::from_utf8_lossy(&buf[..n]).to_string();

            for word in text.split_whitespace() {
                let clean = word.trim_matches(|c: char| {
                    !c.is_alphanumeric() && c != '/' && c != ':' && c != '.'
                        && c != '-' && c != '_' && c != '?' && c != '='
                        && c != '&' && c != '#' && c != '%'
                });
                if clean.starts_with("https://") || clean.starts_with("http://") {
                    let _ = app_pty.emit("browser-open-url", clean.to_string());
                }
            }

            let _ = app_pty.emit(&format!("pty://output/{}", sid), text);
        }

        // ── Session ended ─────────────────────────────────────────────────
        let _ = db::session_end(&db_arc, &sid, None, None);
        let _ = db::event_insert(
            &db_arc,
            &rb_id,
            &sid,
            "session_end",
            &format!("Session ended for agent {:?}", agent_kind_clone),
            None,
        );

        // ── Auto-snapshot memory on session end ───────────────────────────
        if agent_kind_clone != git_memory::AgentKind::Shell {
            let rb_id2  = rb_id.clone();
            let sid2    = sid.clone();
            let db_arc2 = db_arc.clone();
            let app2    = app_pty.clone();

            tauri::async_runtime::spawn(async move {
                let events = db::events_for_session(&db_arc2, &sid2, 50)
                    .unwrap_or_default();

                if events.is_empty() { return; }

                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;

                let duration_secs = ((now_ms - session_start_ms) / 1000).max(0);
                let duration_str  = if duration_secs < 60 {
                    format!("{}s", duration_secs)
                } else {
                    format!("{}m{}s", duration_secs / 60, duration_secs % 60)
                };

                let bullets: Vec<String> = events.iter()
                    .filter(|e| e.event_type != "session_start" && e.event_type != "session_end")
                    .map(|e| format!("• [{}] {}", e.event_type, e.summary))
                    .collect();

                if bullets.is_empty() { return; }

                let summary = format!(
                    "Auto-snapshot (session {}, duration {}): {}",
                    &sid2[..sid2.len().min(8)],
                    duration_str,
                    bullets.join("; "),
                );

                if let Ok(_) = memory::memory_add(&rb_id2, &sid2, &summary).await {
                    git_memory::emit_memory_added(&rb_id2);
                    let _ = app2.emit("memory-added", serde_json::json!({ "runbox_id": rb_id2 }));
                }
            });
        }

        let _ = app_pty.emit(&format!("pty://ended/{}", sid), ());
    });

    Ok(())
}

#[allow(dead_code)]
fn strip_ansi(s: &str) -> String {
    let mut out   = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => { chars.next(); for c2 in chars.by_ref() { if c2.is_ascii_alphabetic() { break; } } }
                Some(']') => { chars.next(); for c2 in chars.by_ref() { if c2 == '\x07' || c2 == '\u{9C}' { break; } } }
                _ => {}
            }
        } else { out.push(c); }
    }
    out
}

#[tauri::command]
fn pty_write(session_id: String, data: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut inject: Option<(String, String, git_memory::AgentKind)> = None;

    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(s) = sessions.get_mut(&session_id) {
            let _ = s.writer.write_all(data.as_bytes());
            let _ = s.writer.flush();

            for ch in data.chars() {
                match ch {
                    '\r' | '\n' => {
                        let line = s.input_buf.trim().to_string();
                        s.input_buf.clear();
                        if !line.is_empty() {
                            let token    = line.split_whitespace().next().unwrap_or("");
                            let base_cmd = token.rsplit(['/', '\\']).next().unwrap_or(token);
                            let kind     = git_memory::AgentKind::detect(base_cmd);
                            if kind != git_memory::AgentKind::Shell {
                                inject = Some((s.runbox_id.clone(), s.cwd.clone(), kind));
                            }
                        }
                    }
                    '\x08' | '\x7f' => { s.input_buf.pop(); }
                    c if !c.is_control() => { s.input_buf.push(c); }
                    _ => {}
                }
            }
        }
    }

    if let Some((rb, cwd, kind)) = inject {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = git_memory::inject_context_for_agent(&rb, &cwd, &kind).await {
                eprintln!("[git_memory] re-inject (user typed {:?}): {e}", kind);
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn pty_resize(session_id: String, cols: u16, rows: u16, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().unwrap().get(&session_id) {
        s._master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(session_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

// ── File watcher commands ─────────────────────────────────────────────────────

/// Start watching a runbox cwd. Emits "file-changed" with { runbox_id } on any
/// file write, create, or delete — debounced 300ms, .git internals excluded.
#[tauri::command]
fn watch_runbox(
    app:       AppHandle,
    runbox_id: String,
    cwd:       String,
    state:     tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cwd_expanded = expand_cwd(&cwd);
    let rid          = runbox_id.clone();

    let debouncer = new_debouncer(Duration::from_millis(300), move |res: notify_debouncer_mini::DebounceEventResult| {
        if let Ok(events) = res {
            let has_change = events.iter().any(|e| {
                matches!(e.kind, DebouncedEventKind::Any) && {
                    let p = e.path.to_string_lossy();
                    // Exclude .git internals and the context file Stackbox writes itself
                    !p.contains("/.git/")
                        && !p.contains("\\.git\\")
                        && !p.ends_with(".stackbox-context.md")
                }
            });
            if has_change {
                let _ = app.emit("file-changed", serde_json::json!({ "runbox_id": rid }));
            }
        }
    }).map_err(|e| e.to_string())?;

    // Watch the cwd recursively — all subdirectories included
    {
        let mut d = debouncer;
        d.watcher()
            .watch(std::path::Path::new(&cwd_expanded), notify::RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        state.watchers.lock().unwrap().insert(runbox_id, d);
    }

    Ok(())
}

/// Stop watching a runbox — called when the runbox is closed or unmounted.
#[tauri::command]
fn unwatch_runbox(runbox_id: String, state: tauri::State<'_, AppState>) {
    state.watchers.lock().unwrap().remove(&runbox_id);
}

// ── Memory commands ───────────────────────────────────────────────────────────
#[tauri::command]
async fn memory_add(runbox_id: String, session_id: String, content: String) -> Result<memory::Memory, String> {
    memory::memory_add(&runbox_id, &session_id, &content).await
}

#[tauri::command]
async fn memory_list(runbox_id: String) -> Result<Vec<memory::Memory>, String> {
    memory::memories_for_runbox(&runbox_id).await
}

#[tauri::command]
async fn memory_delete(id: String) -> Result<(), String> {
    memory::memory_delete(&id).await
}

#[tauri::command]
async fn memory_pin(id: String, pinned: bool) -> Result<(), String> {
    memory::memory_pin(&id, pinned).await
}

#[tauri::command]
async fn memory_update(id: String, content: String) -> Result<(), String> {
    memory::memory_update(&id, &content).await
}

#[tauri::command]
async fn memory_delete_for_runbox(runbox_id: String) -> Result<(), String> {
    memory::memories_delete_for_runbox(&runbox_id).await
}

// ── DB commands ───────────────────────────────────────────────────────────────
#[tauri::command]
fn db_sessions_for_runbox(runbox_id: String, state: tauri::State<'_, AppState>) -> Result<Vec<db::Session>, String> {
    db::sessions_for_runbox(&state.db, &runbox_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_events_for_runbox(
    runbox_id: String,
    query:     Option<String>,
    limit:     Option<usize>,
    state:     tauri::State<'_, AppState>,
) -> Result<Vec<db::SessionEvent>, String> {
    let q   = query.unwrap_or_default();
    let lim = limit.unwrap_or(20);
    if q.trim().is_empty() {
        db::events_recent(&state.db, &runbox_id, lim).map_err(|e| e.to_string())
    } else {
        db::events_search(&state.db, &runbox_id, &q, lim).map_err(|e| e.to_string())
    }
}

// ── Filesystem commands ───────────────────────────────────────────────────────
#[tauri::command]
async fn open_directory_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app.dialog().file().blocking_pick_folder().map(|p| p.to_string()))
}

#[tauri::command]
fn open_in_editor(path: String, editor: String) {
    let cmd = match editor.as_str() { "cursor" => "cursor", _ => "code" };
    std::process::Command::new(cmd).arg(&path).spawn().ok();
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── Entry point ───────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            db:       db::open().expect("failed to open stackbox db"),
            watchers: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            git_memory::set_app_handle(app.handle().clone());

            tauri::async_runtime::spawn(async {
                memory::init().await.expect("memory init failed");
            });

            let app_handle = app.handle().clone();
            let db_handle  = app.state::<AppState>().db.clone();

            tauri::async_runtime::spawn(async move {
                let app_handle = Arc::new(app_handle);
                let db_arc     = Arc::new(db_handle);

                // ── POST /memory — agent writes a memory ──────────────────
                let db_mem = db_arc.clone();
                let memory_route = axum::routing::post(
                    move |axum::extract::Json(body): axum::extract::Json<serde_json::Value>| {
                        let db_mem = db_mem.clone();
                        async move {
                            let runbox_id  = body["runbox_id"].as_str().unwrap_or("__global__").to_string();
                            let content    = body["content"].as_str().unwrap_or("").to_string();
                            if content.is_empty() {
                                return (axum::http::StatusCode::BAD_REQUEST, "missing content").into_response();
                            }
                            let session_id = format!("agent-{}", uuid::Uuid::new_v4());

                            match memory::memory_add(&runbox_id, &session_id, &content).await {
                                Ok(_) => {
                                    let _ = db::event_insert(
                                        &db_mem,
                                        &runbox_id,
                                        &session_id,
                                        "memory",
                                        &content,
                                        None,
                                    );
                                    git_memory::emit_memory_added(&runbox_id);
                                    (axum::http::StatusCode::OK, "ok").into_response()
                                }
                                Err(e) => {
                                    eprintln!("[memory_server] write failed: {e}");
                                    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
                                }
                            }
                        }
                    }
                );

                // ── GET /events — agent queries its own history ───────────
                let db_ev = db_arc.clone();
                let events_route = axum::routing::get(
                    move |axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>| {
                        let db_ev = db_ev.clone();
                        async move {
                            let runbox_id = params.get("runbox_id").cloned().unwrap_or_default();
                            let query     = params.get("q").cloned().unwrap_or_default();
                            let limit     = params.get("limit")
                                .and_then(|s| s.parse::<usize>().ok())
                                .unwrap_or(20);

                            let events = if query.trim().is_empty() {
                                db::events_recent(&db_ev, &runbox_id, limit)
                            } else {
                                db::events_search(&db_ev, &runbox_id, &query, limit)
                            };

                            axum::Json(events.unwrap_or_default()).into_response()
                        }
                    }
                );

                let router = axum::Router::new()
                    .route("/memory", memory_route)
                    .route("/events", events_route)
                    .route("/open-url", axum::routing::post({
                        let h = app_handle.clone();
                        move |body: String| {
                            let h = h.clone();
                            async move { let _ = h.emit("browser-open-url", body); "ok" }
                        }
                    }))
                    .route("/url-changed", axum::routing::get({
                        let h = app_handle.clone();
                        move |axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>| {
                            let h = h.clone();
                            async move {
                                if let (Some(id), Some(url)) = (params.get("id"), params.get("url")) {
                                    let _ = h.emit("browser-url-changed", serde_json::json!({ "id": id, "url": url }));
                                }
                                "ok"
                            }
                        }
                    }));

                let listener = tokio::net::TcpListener::bind(
                    format!("127.0.0.1:{}", git_memory::MEMORY_PORT)
                ).await.unwrap();
                axum::serve(listener, router).await.unwrap();
            });

            Ok(())
        })
        .register_uri_scheme_protocol("proxy", |_ctx, req| handle_proxy_request(req))
        .invoke_handler(tauri::generate_handler![
            // PTY
            pty_spawn, pty_write, pty_resize, pty_kill,
            // File watcher
            watch_runbox, unwatch_runbox,
            // Memory
            memory_add, memory_list, memory_delete, memory_pin,
            memory_update, memory_delete_for_runbox,
            // DB
            db_sessions_for_runbox,
            db_events_for_runbox,
            // Git
            git_memory::git_ensure,
            git_memory::git_log_for_runbox,
            git_memory::git_diff_for_commit,
            git_memory::git_diff_live,
            // Filesystem
            open_directory_dialog, open_in_editor, read_text_file,
            // Browser
            browser_create, browser_destroy, browser_navigate, browser_set_bounds,
            browser_go_back, browser_go_forward, browser_reload, browser_show, browser_hide,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use axum::response::IntoResponse;