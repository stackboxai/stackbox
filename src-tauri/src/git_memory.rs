// src-tauri/src/git_memory.rs
//
// Git-based memory + file change pipeline.
// Replaces memory_pipeline.rs and file_watcher.rs entirely.
//
// How it works:
//   1. On pty_spawn  → ensure git repo exists (init if not), inject context into all agent files
//   2. On session end → run `git diff HEAD` to get what changed, save to LanceDB + rusqlite
//   3. Memory = git log + git diff. No API key. No PTY parsing. No noise filter.
//
// If the user has no git repo → we silently init one at ~/.stackbox/repos/<runbox_id>
// using --separate-git-dir so their working folder stays clean.

use crate::memory::{memory_add, memories_for_runbox};
use std::sync::OnceLock;
use tauri::AppHandle;

// ── Global app handle ─────────────────────────────────────────────────────────

static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: AppHandle) {
    GLOBAL_APP_HANDLE.set(handle).ok();
}

fn emit_memory_added(runbox_id: &str) {
    if let Some(handle) = GLOBAL_APP_HANDLE.get() {
        use tauri::Emitter;
        let _ = handle.emit("memory-added", serde_json::json!({ "runbox_id": runbox_id }));
    }
}

fn emit_file_changed(runbox_id: &str) {
    if let Some(handle) = GLOBAL_APP_HANDLE.get() {
        use tauri::Emitter;
        let _ = handle.emit("file-changed", serde_json::json!({ "runbox_id": runbox_id }));
    }
}

// ── Agent kind ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    CursorAgent,
    GeminiCli,
    GitHubCopilot,
    OpenCode,
    Shell,
}

impl AgentKind {
    pub fn detect(cmd: &str) -> Self {
        let c = cmd.trim().to_lowercase();
        if c.starts_with("claude")   || c.contains("claude-code")     { return Self::ClaudeCode; }
        if c.starts_with("codex")                                      { return Self::Codex; }
        if c.starts_with("cursor")                                     { return Self::CursorAgent; }
        if c.starts_with("gemini")                                     { return Self::GeminiCli; }
        if c.starts_with("copilot") || c.contains("gh copilot")       { return Self::GitHubCopilot; }
        if c.starts_with("opencode")                                   { return Self::OpenCode; }
        Self::Shell
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::ClaudeCode    => "Claude Code",
            Self::Codex         => "OpenAI Codex CLI",
            Self::CursorAgent   => "Cursor Agent",
            Self::GeminiCli     => "Gemini CLI",
            Self::GitHubCopilot => "GitHub Copilot",
            Self::OpenCode      => "OpenCode",
            Self::Shell         => "Shell",
        }
    }

    pub fn launch_cmd(&self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode    => Some("claude\n"),
            Self::Codex         => Some("codex\n"),
            Self::CursorAgent   => Some("cursor .\n"),
            Self::GeminiCli     => Some("gemini\n"),
            Self::GitHubCopilot => Some("gh copilot suggest\n"),
            Self::OpenCode      => Some("opencode\n"),
            Self::Shell         => None,
        }
    }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/// Returns the git dir used for this cwd.
/// If a real .git exists → use it.
/// If not → use ~/.stackbox/git/<runbox_id> as a separate-git-dir.
fn git_dir_for(cwd: &str, runbox_id: &str) -> String {
    let dot_git = std::path::Path::new(cwd).join(".git");
    if dot_git.exists() {
        return dot_git.to_string_lossy().to_string();
    }
    let base = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("stackbox").join("git").join(runbox_id)
        .to_string_lossy()
        .to_string()
}

/// Returns true if cwd is inside a git repo (real .git or our shadow one).
fn has_git(cwd: &str, runbox_id: &str) -> bool {
    let dot_git = std::path::Path::new(cwd).join(".git");
    if dot_git.exists() { return true; }
    let shadow = git_dir_for(cwd, runbox_id);
    std::path::Path::new(&shadow).exists()
}

/// Run a git command in the given cwd, with optional --git-dir override.
fn git(args: &[&str], cwd: &str, git_dir: Option<&str>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    if let Some(gd) = git_dir {
        cmd.arg("--git-dir").arg(gd);
        cmd.arg("--work-tree").arg(cwd);
    }
    cmd.args(args).current_dir(cwd);
    let out = cmd.output().map_err(|e| format!("git exec: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Ensure the cwd has a git repo. Creates a shadow repo if needed.
/// Returns the git_dir to use for all subsequent commands.
pub fn ensure_git_repo(cwd: &str, runbox_id: &str) -> Result<String, String> {
    let dot_git = std::path::Path::new(cwd).join(".git");

    if dot_git.exists() {
        // Real repo — use it directly (git_dir arg = None means git finds it automatically)
        return Ok(dot_git.to_string_lossy().to_string());
    }

    // No .git — create a shadow repo so user's folder stays clean
    let shadow = git_dir_for(cwd, runbox_id);
    let shadow_path = std::path::Path::new(&shadow);

    if !shadow_path.exists() {
        std::fs::create_dir_all(&shadow)
            .map_err(|e| format!("mkdir shadow git: {e}"))?;

        // Init with separate-git-dir
        git(
            &["init", &format!("--separate-git-dir={shadow}"), "."],
            cwd,
            None,
        ).map_err(|e| format!("git init: {e}"))?;

        // Initial commit so diff has something to compare against
        git(&["add", "-A"], cwd, Some(&shadow))?;
        git(
            &["commit", "--allow-empty", "-m", "stackbox: initial snapshot"],
            cwd,
            Some(&shadow),
        ).ok(); // ok if nothing to commit

        eprintln!("[git_memory] created shadow repo at {shadow} for {cwd}");
    }

    Ok(shadow)
}

/// Get the HEAD commit hash (short).
fn head_hash(cwd: &str, git_dir: Option<&str>) -> Option<String> {
    git(&["rev-parse", "--short", "HEAD"], cwd, git_dir).ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── Phase 3: context injection ────────────────────────────────────────────────
//
// Writes ALL agent context files on every spawn.
// Memory content = git log --oneline (last 50 commits) + pinned memories.

const CONTEXT_TOP_N: usize = 20;

pub async fn inject_context_for_agent(
    runbox_id: &str,
    cwd:       &str,
    _agent:    &AgentKind,
) -> Result<(), String> {
    let mut memories = memories_for_runbox(runbox_id).await?;
    let mut globals  = memories_for_runbox("__global__").await.unwrap_or_default();
    memories.append(&mut globals);
    memories.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| b.timestamp.cmp(&a.timestamp)));
    memories.truncate(CONTEXT_TOP_N);

    // Also pull recent git log as additional context
    let git_dir = git_dir_for(cwd, runbox_id);
    let git_dir_opt: Option<&str> = if std::path::Path::new(cwd).join(".git").exists() {
        None
    } else if std::path::Path::new(&git_dir).exists() {
        Some(&git_dir)
    } else {
        None
    };

    let git_log = git(
        &["log", "--oneline", "--no-merges", "-30"],
        cwd,
        git_dir_opt,
    ).unwrap_or_default();

    let base = std::path::Path::new(cwd);

    if memories.is_empty() && git_log.trim().is_empty() {
        // Nothing to inject — clean up stale files
        let _ = std::fs::remove_file(base.join(".stackbox-context.md"));
        return Ok(());
    }

    let content = build_context_md(&memories, &git_log);

    // All agent context targets — written every time
    let targets: &[(&str, bool)] = &[
        (".stackbox-context.md",                false),
        ("CLAUDE.md",                           true),
        ("AGENTS.md",                           true),
        (".cursor/rules/stackbox.md",           false),
        (".cursorrules",                        true),
        ("GEMINI.md",                           true),
        (".github/copilot-instructions.md",     true),
        ("OPENCODE.md",                         true),
    ];

    for (rel_path, preserve_existing) in targets {
        let path = base.join(rel_path);
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).ok();
            }
        }
        let final_content = if *preserve_existing {
            let existing = std::fs::read_to_string(&path).unwrap_or_default();
            merge_into_existing(&existing, &content)
        } else {
            content.clone()
        };
        std::fs::write(&path, final_content)
            .map_err(|e| format!("write {rel_path}: {e}"))?;
    }

    eprintln!(
        "[git_memory] injected {} memories + {} git log lines → all agent files",
        memories.len(),
        git_log.lines().count()
    );
    Ok(())
}

pub async fn inject_context(runbox_id: &str, cwd: &str) -> Result<(), String> {
    inject_context_for_agent(runbox_id, cwd, &AgentKind::Shell).await
}

// ── Phase 2: memory write via git ─────────────────────────────────────────────
//
// Called on session end (PTY process exits).
// Runs: git add -A && git commit → git diff HEAD~1 HEAD → save to LanceDB + rusqlite.

pub async fn commit_and_capture(
    runbox_id:  &str,
    session_id: &str,
    cwd:        &str,
    db:         &crate::db::Db,
) {
    let git_dir = git_dir_for(cwd, runbox_id);
    let real_git = std::path::Path::new(cwd).join(".git").exists();
    let git_dir_opt: Option<&str> = if real_git { None } else {
        if std::path::Path::new(&git_dir).exists() { Some(&git_dir) } else { return; }
    };

    // Stage everything
    if git(&["add", "-A"], cwd, git_dir_opt).is_err() { return; }

    // Check if there's anything to commit
    let status = git(&["status", "--porcelain"], cwd, git_dir_opt)
        .unwrap_or_default();
    if status.trim().is_empty() {
        eprintln!("[git_memory] nothing changed — skipping commit for {runbox_id}");
        return;
    }

    // Commit
    let msg = format!("stackbox: session {}", &session_id[..session_id.len().min(8)]);
    if git(&["commit", "-m", &msg], cwd, git_dir_opt).is_err() {
        return;
    }

    let hash = head_hash(cwd, git_dir_opt).unwrap_or_else(|| "unknown".to_string());
    eprintln!("[git_memory] committed {hash} for runbox {runbox_id}");

    // Get the diff for this commit
    let diff = git(&["diff", "HEAD~1", "HEAD"], cwd, git_dir_opt)
        .unwrap_or_default();

    if diff.trim().is_empty() { return; }

    // Save file changes to rusqlite (for the Files tab in MemoryPanel)
    save_diff_to_db(&diff, session_id, runbox_id, db);

    // Save a memory: what changed in this session (git log one-liner style)
    let summary = git(
        &["log", "--oneline", "-1"],
        cwd,
        git_dir_opt,
    ).unwrap_or_default();

    let changed_files: Vec<&str> = diff
        .lines()
        .filter(|l| l.starts_with("diff --git"))
        .map(|l| l.split(" b/").nth(1).unwrap_or(""))
        .filter(|s| !s.is_empty())
        .take(5)
        .collect();

    if !changed_files.is_empty() {
        let content = if changed_files.len() == 1 {
            format!("Modified {} — {}", changed_files[0], summary.trim())
        } else {
            format!(
                "Modified {} files ({}) — {}",
                changed_files.len(),
                changed_files.join(", "),
                summary.trim()
            )
        };

        if let Ok(_mem) = memory_add(runbox_id, session_id, &content).await {
            emit_memory_added(runbox_id);
        }
    }

    emit_file_changed(runbox_id);
}

// ── Save diff lines to rusqlite file_changes ──────────────────────────────────

fn save_diff_to_db(
    diff:       &str,
    session_id: &str,
    runbox_id:  &str,
    db:         &crate::db::Db,
) {
    // Split unified diff into per-file chunks
    let mut current_file: Option<String> = None;
    let mut current_diff = String::new();

    for line in diff.lines() {
        if line.starts_with("diff --git") {
            // Flush previous file
            if let Some(ref path) = current_file {
                let change_type = detect_change_type(&current_diff);
                let _ = crate::db::file_change_insert(
                    db, session_id, runbox_id,
                    path, change_type,
                    Some(current_diff.trim()),
                );
            }
            // Start new file — extract path from "diff --git a/foo b/foo"
            current_file = line.split(" b/").nth(1).map(|s| s.to_string());
            current_diff = line.to_string() + "\n";
        } else if current_file.is_some() {
            current_diff.push_str(line);
            current_diff.push('\n');
        }
    }

    // Flush last file
    if let Some(ref path) = current_file {
        if !current_diff.trim().is_empty() {
            let change_type = detect_change_type(&current_diff);
            let _ = crate::db::file_change_insert(
                db, session_id, runbox_id,
                path, change_type,
                Some(current_diff.trim()),
            );
        }
    }
}

fn detect_change_type(diff: &str) -> &'static str {
    if diff.contains("new file mode")     { "created"  }
    else if diff.contains("deleted file") { "deleted"  }
    else                                  { "modified" }
}

// ── Context file builder ──────────────────────────────────────────────────────

fn build_context_md(memories: &[crate::memory::Memory], git_log: &str) -> String {
    let mem_section = if memories.is_empty() {
        "*No memories yet.*\n".to_string()
    } else {
        memories.iter().map(|m| {
            let pin = if m.pinned { " 📌" } else { "" };
            format!("- {}{}\n", m.content.trim(), pin)
        }).collect()
    };

    let git_section = if git_log.trim().is_empty() {
        "*No commits yet.*\n".to_string()
    } else {
        git_log.lines()
            .map(|l| format!("- {l}\n"))
            .collect()
    };

    format!(
        "# Stackbox Memory Context\n\
         > Auto-generated. Updated on every session start.\n\
         > Edit your own content OUTSIDE the stackbox markers.\n\
         \n\
         ## Session memories ({count})\n\
         \n\
         {mem_section}\n\
         ## Recent git history\n\
         \n\
         {git_section}\n\
         ## Instructions\n\
         Read the above before starting work. \
         Memories capture architecture decisions, bugs, and patterns from previous sessions. \
         Git history shows what was changed and when.\n\
         \n\
         ---\n\
         *Managed by Stackbox*\n",
        count      = memories.len(),
        mem_section = mem_section,
        git_section = git_section,
    )
}

fn merge_into_existing(existing: &str, new_block: &str) -> String {
    const START: &str = "<!-- stackbox:start -->";
    const END:   &str = "<!-- stackbox:end -->";
    let block = format!("{START}\n{new_block}\n{END}");

    if existing.trim().is_empty() {
        return block + "\n";
    }
    if let (Some(s), Some(e)) = (existing.find(START), existing.find(END)) {
        let before = &existing[..s];
        let after  = &existing[e + END.len()..];
        format!("{before}{block}{after}")
    } else {
        format!("{block}\n\n{existing}")
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Ensure git exists for a cwd. Called from frontend on runbox create.
/// Returns whether a shadow repo was created (false = real .git found).
#[tauri::command]
pub async fn git_ensure(cwd: String, runbox_id: String) -> Result<bool, String> {
    let had_git = has_git(&cwd, &runbox_id);
    ensure_git_repo(&cwd, &runbox_id)?;
    Ok(!had_git) // true = we created a new repo
}

/// Get git log for a runbox — used by MemoryPanel git history tab.
#[tauri::command]
pub async fn git_log_for_runbox(cwd: String, runbox_id: String) -> Result<Vec<GitCommit>, String> {
    let git_dir = git_dir_for(&cwd, &runbox_id);
    let real_git = std::path::Path::new(&cwd).join(".git").exists();
    let git_dir_opt: Option<&str> = if real_git { None } else {
        if std::path::Path::new(&git_dir).exists() { Some(git_dir.as_str()) } else {
            return Ok(vec![]);
        }
    };

    let log = git(
        &["log", "--pretty=format:%H|%h|%s|%ai|%an", "--no-merges", "-50"],
        &cwd,
        git_dir_opt,
    ).unwrap_or_default();

    let commits = log.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let parts: Vec<&str> = l.splitn(5, '|').collect();
            if parts.len() < 5 { return None; }
            Some(GitCommit {
                hash:      parts[0].to_string(),
                short_hash: parts[1].to_string(),
                message:   parts[2].to_string(),
                date:      parts[3].to_string(),
                author:    parts[4].to_string(),
            })
        })
        .collect();

    Ok(commits)
}

/// Get git diff for a specific commit — used by MemoryPanel diff view.
#[tauri::command]
pub async fn git_diff_for_commit(
    cwd:       String,
    runbox_id: String,
    hash:      String,
) -> Result<String, String> {
    let git_dir = git_dir_for(&cwd, &runbox_id);
    let real_git = std::path::Path::new(&cwd).join(".git").exists();
    let git_dir_opt: Option<&str> = if real_git { None } else {
        if std::path::Path::new(&git_dir).exists() { Some(git_dir.as_str()) } else {
            return Ok(String::new());
        }
    };

    git(
        &["diff", &format!("{hash}~1"), &hash],
        &cwd,
        git_dir_opt,
    )
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct GitCommit {
    pub hash:       String,
    pub short_hash: String,
    pub message:    String,
    pub date:       String,
    pub author:     String,
}