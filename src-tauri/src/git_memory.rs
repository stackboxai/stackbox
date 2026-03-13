// src-tauri/src/git_memory.rs
//
// Context injection pipeline for Stackbox.
//
// How it works:
//   1. On pty_spawn → ensure git repo exists (init shadow repo if no .git)
//   2. On pty_spawn → inject memories + git log + memory write instruction into agent files
//      (only writes files relevant to the detected agent kind — not all 8 every time)
//   3. Agent writes its own memories via: POST http://localhost:7547/memory
//   4. Files tab → git_diff_live() runs `git diff HEAD` on demand (no capturing)
//
// Context injection uses BM25 search (via session_events FTS5) to rank memories
// by relevance to the current task (last git commit message used as query),
// rather than a flat newest-N truncation. Pinned memories always appear first.

use crate::memory::memories_for_runbox;
use crate::db;
use std::sync::OnceLock;
use tauri::AppHandle;

// ── Memory server port (shared with lib.rs axum server) ──────────────────
pub const MEMORY_PORT: u16 = 7547;

// ── Global app handle ─────────────────────────────────────────────────────
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: AppHandle) {
    GLOBAL_APP_HANDLE.set(handle).ok();
}

pub fn emit_memory_added(runbox_id: &str) {
    if let Some(handle) = GLOBAL_APP_HANDLE.get() {
        use tauri::Emitter;
        let _ = handle.emit("memory-added", serde_json::json!({ "runbox_id": runbox_id }));
    }
}

// ── Global DB handle — set once from lib.rs so git_memory can search events ──
static GLOBAL_DB: OnceLock<db::Db> = OnceLock::new();

pub fn set_global_db(db: db::Db) {
    GLOBAL_DB.set(db).ok();
}

fn get_db() -> Option<&'static db::Db> {
    GLOBAL_DB.get()
}

// ── Agent kind ────────────────────────────────────────────────────────────
// Clone is required so pty_spawn can move agent_kind into the inject spawn.
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
        if c.contains("claude")   { return Self::ClaudeCode; }
        if c.contains("codex")    { return Self::Codex; }
        if c.contains("agent")    { return Self::CursorAgent; }
        if c.contains("gemini")   { return Self::GeminiCli; }
        if c.contains("copilot")  { return Self::GitHubCopilot; }
        if c.contains("opencode") { return Self::OpenCode; }
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

    pub fn launch_cmd_for(&self, ctx_file: &str) -> Option<String> {
        match self {
            Self::ClaudeCode    => Some(format!("claude --append-system-prompt-file {ctx_file}\n")),
            Self::GeminiCli     => Some("gemini\n".to_string()),
            Self::Codex         => Some("codex\n".to_string()),
            Self::OpenCode      => Some("opencode\n".to_string()),
            Self::CursorAgent   => Some("agent\n".to_string()),
            Self::GitHubCopilot => Some("gh copilot suggest\n".to_string()),
            Self::Shell         => None,
        }
    }
}

// ── Git helpers ───────────────────────────────────────────────────────────
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

fn has_git(cwd: &str, runbox_id: &str) -> bool {
    let dot_git = std::path::Path::new(cwd).join(".git");
    if dot_git.exists() { return true; }
    let shadow = git_dir_for(cwd, runbox_id);
    std::path::Path::new(&shadow).exists()
}

fn git(args: &[&str], cwd: &str, git_dir: Option<&str>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    if let Some(gd) = git_dir {
        let abs_gd  = std::fs::canonicalize(gd).unwrap_or_else(|_| std::path::PathBuf::from(gd));
        let abs_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| std::path::PathBuf::from(cwd));
        cmd.arg("--git-dir").arg(&abs_gd);
        cmd.arg("--work-tree").arg(&abs_cwd);
        cmd.current_dir(&abs_cwd);
    } else {
        cmd.current_dir(cwd);
    }
    cmd.args(args);
    let out = cmd.output().map_err(|e| format!("git exec: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn ensure_git_repo(cwd: &str, runbox_id: &str) -> Result<String, String> {
    let dot_git = std::path::Path::new(cwd).join(".git");

    if dot_git.is_dir() {
        return Ok(dot_git.to_string_lossy().to_string());
    }

    if dot_git.is_file() { let _ = std::fs::remove_file(&dot_git); }

    let shadow = git_dir_for(cwd, runbox_id);
    let shadow_head = std::path::Path::new(&shadow).join("HEAD");

    if shadow_head.exists() {
        return Ok(shadow);
    }

    let shadow_path = std::path::Path::new(&shadow);
    if !shadow_path.exists() {
        std::fs::create_dir_all(&shadow)
            .map_err(|e| format!("mkdir shadow git: {e}"))?;
    }

    std::process::Command::new("git")
        .args(["init", "--bare"])
        .current_dir(&shadow)
        .output()
        .map_err(|e| format!("git init --bare: {e}"))?;

    std::process::Command::new("git")
        .args(["config", "core.worktree", cwd])
        .current_dir(&shadow)
        .output()
        .map_err(|e| format!("git config worktree: {e}"))?;

    git(&["add", "-A"], cwd, Some(&shadow)).ok();
    git(
        &["commit", "--allow-empty", "-m", "stackbox: initial snapshot"],
        cwd,
        Some(&shadow),
    ).ok();

    eprintln!("[git_memory] created shadow repo at {shadow} for {cwd}");
    Ok(shadow)
}

// ── Context injection ─────────────────────────────────────────────────────

/// How many pinned memories to always include regardless of BM25 ranking
const PINNED_LIMIT:  usize = 10;
/// How many BM25-ranked event summaries to include
const EVENTS_LIMIT:  usize = 10;
/// Hard cap on total memories shown (pinned + regular combined)
const CONTEXT_TOP_N: usize = 20;

pub async fn inject_context_for_agent(
    runbox_id: &str,
    cwd:       &str,
    agent:     &AgentKind,
) -> Result<(), String> {
    // ── 1. Load all memories for this runbox + global memories ────────────
    let mut memories = memories_for_runbox(runbox_id).await?;
    let mut globals  = memories_for_runbox("__global__").await.unwrap_or_default();
    memories.append(&mut globals);

    // ── 2. Separate pinned from unpinned ──────────────────────────────────
    let mut pinned: Vec<_>   = memories.iter().filter(|m|  m.pinned).cloned().collect();
    let mut unpinned: Vec<_> = memories.iter().filter(|m| !m.pinned).cloned().collect();
    pinned.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    unpinned.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    // Keep all pinned (up to cap) — they are always relevant
    pinned.truncate(PINNED_LIMIT);

    // ── 3. BM25 search over session_events to rank unpinned memories ──────
    //
    // Use the most recent git commit message as the search query — it's the
    // best available signal of what the agent is currently working on.
    let git_dir = git_dir_for(cwd, runbox_id);
    let git_dir_opt: Option<&str> = if std::path::Path::new(cwd).join(".git").exists() {
        None
    } else if std::path::Path::new(&git_dir).exists() {
        Some(&git_dir)
    } else {
        None
    };

    let recent_commit = git(&["log", "--oneline", "-1"], cwd, git_dir_opt).unwrap_or_default();
    // Drop the hash prefix — keep only the commit message words
    let search_query: String = recent_commit
        .split_whitespace()
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ");

    // Try BM25 search if we have a DB handle and a meaningful query
    let relevant_summaries: Vec<String> = if !search_query.is_empty() {
        if let Some(db) = get_db() {
            db::events_search(db, runbox_id, &search_query, EVENTS_LIMIT)
                .unwrap_or_default()
                .into_iter()
                .map(|e| e.summary)
                .collect()
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    // Score unpinned memories: ones whose content overlaps with BM25 results float up
    // Simple heuristic — check if the memory content shares any words with a relevant summary
    let relevant_words: std::collections::HashSet<String> = relevant_summaries
        .iter()
        .flat_map(|s| s.split_whitespace().map(|w| w.to_lowercase()))
        .filter(|w| w.len() > 3) // skip stop-words
        .collect();

    if !relevant_words.is_empty() {
        unpinned.sort_by(|a, b| {
            let score_a = relevance_score(&a.content, &relevant_words);
            let score_b = relevance_score(&b.content, &relevant_words);
            score_b.cmp(&score_a)
                .then_with(|| b.timestamp.cmp(&a.timestamp))
        });
    }

    // Trim unpinned to leave room for pinned within the hard cap
    let unpinned_limit = CONTEXT_TOP_N.saturating_sub(pinned.len());
    unpinned.truncate(unpinned_limit);

    // Final ordered list: pinned first, then ranked unpinned
    let mut final_memories = pinned;
    final_memories.extend(unpinned);

    // ── 4. Git log ────────────────────────────────────────────────────────
    let git_log = git(
        &["log", "--oneline", "--no-merges", "-30"],
        cwd,
        git_dir_opt,
    ).unwrap_or_default();

    // ── 5. Build context markdown ─────────────────────────────────────────
    let base    = std::path::Path::new(cwd);
    let content = build_context_md(runbox_id, &final_memories, &git_log);

    // ── 6. Write files ────────────────────────────────────────────────────
    let base_targets: &[(&str, bool)] = &[
        (".stackbox-context.md", false),
    ];

    let agent_targets: Vec<(&str, bool)> = match agent {
        AgentKind::ClaudeCode => vec![
            ("CLAUDE.md",                          true),   // root context (auto-loaded by claude)
            (".claude/skills/stackbox/SKILL.md",   false),  // project skill — /stackbox or auto
        ],
        AgentKind::Codex => vec![
            ("AGENTS.md",                          true),   // root context (auto-loaded by codex)
            (".codex/skills/stackbox/SKILL.md",    false),  // codex skill dir (cursor also reads .codex)
        ],
        AgentKind::GeminiCli => vec![
            ("GEMINI.md",                                  true),   // root context
            (".gemini/skills/stackbox/SKILL.md",           false),  // gemini workspace skill
            (".agents/skills/stackbox/SKILL.md",           false),  // .agents alias — higher precedence
        ],
        AgentKind::OpenCode => vec![
            ("OPENCODE.md",                        true),
        ],
        AgentKind::CursorAgent => vec![
            (".agents/skills/stackbox/SKILL.md",   false),  // primary — highest precedence in cursor
            (".cursor/skills/stackbox/SKILL.md",   false),  // cursor-specific fallback
        ],
        AgentKind::GitHubCopilot => vec![
            (".github/copilot-instructions.md",        true),   // repo-wide custom instructions
            (".github/skills/stackbox/SKILL.md",       false),  // project skill
        ],
        AgentKind::Shell => vec![],
    };

    // Skill files get YAML frontmatter so agents list them under /skills
    let skill_content = format!(
        "---\nname: stackbox-context\ndescription: Project memory and context from Stackbox. Read this before starting any task.\n---\n\n{c}",
        c = content
    );

    let all_targets = base_targets.iter()
        .copied()
        .chain(agent_targets.iter().copied());

    for (rel_path, preserve_existing) in all_targets {
        let path = base.join(rel_path);
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).ok();
            }
        }
        // Gemini skill files get YAML frontmatter; everything else gets plain content
        let raw = if rel_path.contains("/skills/stackbox/SKILL.md") {
            skill_content.clone()
        } else {
            content.clone()
        };
        let final_content = if preserve_existing {
            let existing = std::fs::read_to_string(&path).unwrap_or_default();
            merge_into_existing(&existing, &raw)
        } else {
            raw
        };
        std::fs::write(&path, final_content)
            .map_err(|e| format!("write {rel_path}: {e}"))?;
    }

    eprintln!(
        "[git_memory] injected {} memories (query={:?}) + {} git log lines → {:?} agent",
        final_memories.len(),
        search_query,
        git_log.lines().count(),
        agent,
    );
    Ok(())
}

/// Simple word-overlap relevance score between memory content and BM25 result words.
fn relevance_score(content: &str, relevant_words: &std::collections::HashSet<String>) -> usize {
    content
        .split_whitespace()
        .filter(|w| relevant_words.contains(&w.to_lowercase()))
        .count()
}

pub async fn inject_context(runbox_id: &str, cwd: &str) -> Result<(), String> {
    inject_context_for_agent(runbox_id, cwd, &AgentKind::Shell).await
}

// ── Context file builder ──────────────────────────────────────────────────
fn build_context_md(runbox_id: &str, memories: &[crate::memory::Memory], git_log: &str) -> String {
    // Build the memory-save snippet as a plain string first — avoids escaping
    // nightmares inside the outer format! call.
    let snippet = {
        // Avoid single quotes inside format! (Rust 2021 reserved prefix rule).
        // Use PowerShell hashtable syntax — no quoting issues on Windows.
        let port = MEMORY_PORT;
        format!(
            "```powershell\n\
             $body = @{{runbox_id=\"{runbox_id}\"; content=\"YOUR SUMMARY HERE\"}} | ConvertTo-Json\n\
             Invoke-RestMethod http://localhost:{port}/memory -Method Post -ContentType \"application/json\" -Body $body\n\
             ```",
            runbox_id = runbox_id,
            port      = port,
        )
    };

    let instructions = format!(
        "## Stackbox Instructions\n\
         \n\
         Before starting any work:\n\
         1. Read all memories below — they contain what previous agents did\n\
         2. Use them as context for your work\n\
         \n\
         After completing each task or meaningful checkpoint:\n\
         - Save a memory with a brief summary (1-3 sentences)\n\
         - Include: what you did, which files changed, and any known issues\n\
         \n\
         {snippet}\n\
         \n\
         You can also query your event history:\n\
         ```powershell\n\
         Invoke-RestMethod \"http://localhost:{port}/events?runbox_id={runbox_id}&q=YOUR+QUERY\" | ConvertTo-Json\n\
         ```\n",
        snippet    = snippet,
        port       = MEMORY_PORT,
        runbox_id  = runbox_id,
    );

    let memories_section = if memories.is_empty() {
        String::new()
    } else {
        let entries: String = memories.iter().map(|m| {
            let pin = if m.pinned { " 📌" } else { "" };
            let ts  = format_ts(m.timestamp);
            format!("- [{}]{} {}\n", ts, pin, m.content.trim())
        }).collect();
        format!("## Memories from previous sessions\n\n{entries}\n")
    };

    let git_section = if git_log.trim().is_empty() {
        String::new()
    } else {
        let entries: String = git_log.lines()
            .map(|l| format!("- {l}\n"))
            .collect();
        format!("## Recent git commits\n\n{entries}\n")
    };

    format!(
        "# Stackbox Context\n\
         > Auto-generated by Stackbox. Updated on every session start.\n\
         > Do not edit this block — put your own notes outside the stackbox markers.\n\
         \n\
         {instructions}\n\
         {memories_section}\
         {git_section}\
         ---\n\
         *Managed by Stackbox — stackbox.dev*\n"
    )
}

fn format_ts(ms: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let diff = (now - ms).max(0) / 1000;
    if diff < 60        { return "just now".to_string(); }
    if diff < 3600      { return format!("{}m ago", diff / 60); }
    if diff < 86400     { return format!("{}h ago", diff / 3600); }
    format!("{}d ago", diff / 86400)
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

// ── Live diff helpers ─────────────────────────────────────────────────────
fn git_dir_opt_for(cwd: &str, runbox_id: &str) -> Option<String> {
    if std::path::Path::new(cwd).join(".git").exists() {
        return None;
    }
    let shadow = git_dir_for(cwd, runbox_id);
    if std::path::Path::new(&shadow).exists() {
        Some(shadow)
    } else {
        None
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────
#[tauri::command]
pub async fn git_ensure(cwd: String, runbox_id: String) -> Result<bool, String> {
    let had_git = has_git(&cwd, &runbox_id);
    ensure_git_repo(&cwd, &runbox_id)?;
    Ok(!had_git)
}

#[tauri::command]
pub async fn git_log_for_runbox(cwd: String, runbox_id: String) -> Result<Vec<GitCommit>, String> {
    let git_dir_opt = git_dir_opt_for(&cwd, &runbox_id);
    let gdo: Option<&str> = git_dir_opt.as_deref();

    let log = git(
        &["log", "--pretty=format:%H|%h|%s|%ai|%an", "--no-merges", "-50"],
        &cwd,
        gdo,
    ).unwrap_or_default();

    let commits = log.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let parts: Vec<&str> = l.splitn(5, '|').collect();
            if parts.len() < 5 { return None; }
            Some(GitCommit {
                hash:       parts[0].to_string(),
                short_hash: parts[1].to_string(),
                message:    parts[2].to_string(),
                date:       parts[3].to_string(),
                author:     parts[4].to_string(),
            })
        })
        .collect();

    Ok(commits)
}

#[tauri::command]
pub async fn git_diff_for_commit(
    cwd:       String,
    runbox_id: String,
    hash:      String,
) -> Result<String, String> {
    let git_dir_opt = git_dir_opt_for(&cwd, &runbox_id);
    let gdo: Option<&str> = git_dir_opt.as_deref();
    git(&["diff", &format!("{hash}~1"), &hash], &cwd, gdo)
}

// ── Filesystem mtime helper ───────────────────────────────────────────────────
fn mtime_ms(cwd: &str, rel_path: &str) -> u64 {
    use std::time::UNIX_EPOCH;
    let full = std::path::Path::new(cwd).join(rel_path);
    std::fs::metadata(&full)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Live diff of uncommitted changes — used by the Files tab.
/// Returns uncommitted file changes. Does NOT run git add -A — never mutates the index.
#[tauri::command]
pub async fn git_diff_live(
    cwd:       String,
    runbox_id: String,
) -> Result<Vec<LiveDiffFile>, String> {
    let git_dir_opt = git_dir_opt_for(&cwd, &runbox_id);
    let gdo: Option<&str> = git_dir_opt.as_deref();

    // 1. Diff against HEAD (repo has at least one commit — most common case)
    let mut diff    = git(&["diff", "HEAD"],              &cwd, gdo).unwrap_or_default();
    let mut numstat = git(&["diff", "HEAD", "--numstat"], &cwd, gdo).unwrap_or_default();

    // 2. Nothing vs HEAD — try staged-only (new repo, first commit not yet made)
    if diff.trim().is_empty() {
        diff    = git(&["diff", "--cached"],               &cwd, gdo).unwrap_or_default();
        numstat = git(&["diff", "--cached", "--numstat"],  &cwd, gdo).unwrap_or_default();
    }

    // 3. Still empty — show untracked files as "created" via git status
    if diff.trim().is_empty() {
        let status = git(&["status", "--porcelain"], &cwd, gdo).unwrap_or_default();
        let files: Vec<LiveDiffFile> = status.lines()
            .filter(|l| l.trim_start().starts_with("??"))
            .map(|l| {
                let path = l.trim_start_matches("??").trim().to_string();
                LiveDiffFile {
                    path:        path.clone(),
                    change_type: "created".to_string(),
                    diff:        format!("diff --git a/{path} b/{path}\nnew file (untracked — stage to see diff)"),
                    insertions:  0,
                    deletions:   0,
                    modified_at: mtime_ms(&cwd, &path),
                }
            })
            .collect();
        return Ok(files);
    }

    Ok(parse_diff_into_files(&diff, &numstat, &cwd))
}

fn parse_diff_into_files(diff: &str, numstat: &str, cwd: &str) -> Vec<LiveDiffFile> {
    // Build stat map from numstat — format is: "additions\tdeletions\tpath"
    // This is immune to the path truncation that --stat does.
    let mut stat_map: std::collections::HashMap<String, (i32, i32)> = std::collections::HashMap::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() == 3 {
            let ins = parts[0].parse::<i32>().unwrap_or(0);
            let del = parts[1].parse::<i32>().unwrap_or(0);
            stat_map.insert(parts[2].to_string(), (ins, del));
        }
    }

    let mut files: Vec<LiveDiffFile> = Vec::new();
    let mut current_path = String::new();
    let mut current_diff = String::new();
    let mut change_type  = "modified";

    for line in diff.lines() {
        if line.starts_with("diff --git") {
            if !current_path.is_empty() {
                let (ins, del) = stat_map.get(&current_path).copied().unwrap_or((0, 0));
                files.push(LiveDiffFile {
                    path:        current_path.clone(),
                    change_type: change_type.to_string(),
                    diff:        current_diff.clone(),
                    insertions:  ins,
                    deletions:   del,
                    modified_at: mtime_ms(cwd, &current_path),
                });
            }
            current_path = line.split(" b/").nth(1).unwrap_or("").to_string();
            current_diff = line.to_string() + "\n";
            change_type  = "modified";
        } else if line.starts_with("new file mode") {
            change_type = "created";
            current_diff.push_str(line);
            current_diff.push('\n');
        } else if line.starts_with("deleted file mode") {
            change_type = "deleted";
            current_diff.push_str(line);
            current_diff.push('\n');
        } else if !current_path.is_empty() {
            current_diff.push_str(line);
            current_diff.push('\n');
        }
    }

    if !current_path.is_empty() && !current_diff.trim().is_empty() {
        let (ins, del) = stat_map.get(&current_path).copied().unwrap_or((0, 0));
        files.push(LiveDiffFile {
            path:        current_path.clone(),
            change_type: change_type.to_string(),
            diff:        current_diff,
            insertions:  ins,
            deletions:   del,
            modified_at: mtime_ms(cwd, &current_path),
        });
    }

    files
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct GitCommit {
    pub hash:       String,
    pub short_hash: String,
    pub message:    String,
    pub date:       String,
    pub author:     String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct LiveDiffFile {
    pub path:        String,
    pub change_type: String,  // "created" | "modified" | "deleted"
    pub diff:        String,
    pub insertions:  i32,
    pub deletions:   i32,
    pub modified_at: u64,     // Unix ms — filesystem mtime, 0 if unavailable
}