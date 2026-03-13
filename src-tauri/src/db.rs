// src-tauri/src/db.rs
// rusqlite — runboxes, sessions, pane_layouts, session_events (FTS5)

use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// ── Public handle ─────────────────────────────────────────────────────────
pub type Db = Arc<Mutex<Connection>>;

// ── Row types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Runbox {
    pub id:         String,
    pub name:       String,
    pub cwd:        String,
    pub branch:     Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id:         String,
    pub runbox_id:  String,
    pub pane_id:    String,
    pub agent:      String,
    pub cwd:        String,
    pub started_at: i64,
    pub ended_at:   Option<i64>,
    pub exit_code:  Option<i32>,
    pub log_path:   Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaneLayout {
    pub runbox_id:   String,
    pub layout_json: String,
    pub active_pane: String,
    pub updated_at:  i64,
}

/// A structured event capturing agent activity — powers FTS5 BM25 search.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionEvent {
    pub id:         String,
    pub runbox_id:  String,
    pub session_id: String,
    /// "session_start" | "session_end" | "memory" | "file_change" | "git"
    pub event_type: String,
    /// Short human-readable summary — indexed by FTS5
    pub summary:    String,
    /// Optional full content (long diff text, raw output, etc.)
    pub detail:     Option<String>,
    pub timestamp:  i64,
}

// ── Init ──────────────────────────────────────────────────────────────────

pub fn db_path() -> PathBuf {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("stackbox").join("stackbox.db")
}

pub fn open() -> Result<Db> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(&path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

fn migrate(conn: &Connection) -> Result<()> {
    // Core tables
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS runboxes (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            cwd        TEXT NOT NULL,
            branch     TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id         TEXT PRIMARY KEY,
            runbox_id  TEXT NOT NULL REFERENCES runboxes(id) ON DELETE CASCADE,
            pane_id    TEXT NOT NULL DEFAULT '',
            agent      TEXT NOT NULL DEFAULT 'shell',
            cwd        TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at   INTEGER,
            exit_code  INTEGER,
            log_path   TEXT
        );

        CREATE TABLE IF NOT EXISTS pane_layouts (
            runbox_id   TEXT PRIMARY KEY REFERENCES runboxes(id) ON DELETE CASCADE,
            layout_json TEXT NOT NULL,
            active_pane TEXT NOT NULL DEFAULT '',
            updated_at  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_runbox ON sessions(runbox_id);
    ")?;

    // Session events table — powers context-mode-style BM25 retrieval
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS session_events (
            id         TEXT PRIMARY KEY,
            runbox_id  TEXT NOT NULL,
            session_id TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            summary    TEXT NOT NULL,
            detail     TEXT,
            timestamp  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_runbox    ON session_events(runbox_id);
        CREATE INDEX IF NOT EXISTS idx_events_runbox_ts ON session_events(runbox_id, timestamp DESC);
    ")?;

    // FTS5 virtual table — BM25 ranked search over summary + detail
    // Must be separate from the CREATE TABLE above because SQLite's execute_batch
    // stops on certain DDL errors if the virtual table already exists, so we guard
    // the creation in Rust instead.
    let fts_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_events_fts'",
        [],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(0) > 0;

    if !fts_exists {
        conn.execute_batch("
            CREATE VIRTUAL TABLE session_events_fts USING fts5(
                summary,
                detail,
                content='session_events',
                content_rowid='rowid',
                tokenize='porter ascii'
            );

            -- Keep FTS index in sync automatically
            CREATE TRIGGER events_ai AFTER INSERT ON session_events BEGIN
                INSERT INTO session_events_fts(rowid, summary, detail)
                VALUES (new.rowid, new.summary, new.detail);
            END;

            CREATE TRIGGER events_ad AFTER DELETE ON session_events BEGIN
                INSERT INTO session_events_fts(session_events_fts, rowid, summary, detail)
                VALUES ('delete', old.rowid, old.summary, old.detail);
            END;
        ")?;
    }

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── Runbox CRUD ───────────────────────────────────────────────────────────

pub fn runbox_create(db: &Db, id: &str, name: &str, cwd: &str) -> Result<Runbox> {
    let now = now_ms();
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO runboxes (id, name, cwd, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, cwd, now, now],
    )?;
    Ok(Runbox {
        id: id.to_string(), name: name.to_string(), cwd: cwd.to_string(),
        branch: None, created_at: now, updated_at: now,
    })
}

pub fn runbox_list(db: &Db) -> Result<Vec<Runbox>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, cwd, branch, created_at, updated_at
         FROM runboxes ORDER BY created_at ASC"
    )?;
    let rows = stmt.query_map([], |r| Ok(Runbox {
        id:         r.get(0)?,
        name:       r.get(1)?,
        cwd:        r.get(2)?,
        branch:     r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    }))?;
    rows.collect()
}

pub fn runbox_rename(db: &Db, id: &str, name: &str) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE runboxes SET name=?1, updated_at=?2 WHERE id=?3",
        params![name, now_ms(), id],
    )?;
    Ok(())
}

pub fn runbox_delete(db: &Db, id: &str) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM runboxes WHERE id=?1", params![id])?;
    Ok(())
}

// ── Session CRUD ──────────────────────────────────────────────────────────

pub fn session_start(db: &Db, id: &str, runbox_id: &str, pane_id: &str, agent: &str, cwd: &str) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO sessions (id, runbox_id, pane_id, agent, cwd, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, runbox_id, pane_id, agent, cwd, now_ms()],
    )?;
    Ok(())
}

pub fn session_end(db: &Db, id: &str, exit_code: Option<i32>, log_path: Option<&str>) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE sessions SET ended_at=?1, exit_code=?2, log_path=?3 WHERE id=?4",
        params![now_ms(), exit_code, log_path, id],
    )?;
    Ok(())
}

pub fn sessions_for_runbox(db: &Db, runbox_id: &str) -> Result<Vec<Session>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, runbox_id, pane_id, agent, cwd, started_at, ended_at, exit_code, log_path
         FROM sessions WHERE runbox_id=?1 ORDER BY started_at DESC"
    )?;
    let rows = stmt.query_map(params![runbox_id], |r| Ok(Session {
        id:         r.get(0)?,
        runbox_id:  r.get(1)?,
        pane_id:    r.get(2)?,
        agent:      r.get(3)?,
        cwd:        r.get(4)?,
        started_at: r.get(5)?,
        ended_at:   r.get(6)?,
        exit_code:  r.get(7)?,
        log_path:   r.get(8)?,
    }))?;
    rows.collect()
}

// ── Pane layout ───────────────────────────────────────────────────────────

pub fn layout_save(db: &Db, runbox_id: &str, layout_json: &str, active_pane: &str) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO pane_layouts (runbox_id, layout_json, active_pane, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(runbox_id) DO UPDATE SET
           layout_json=excluded.layout_json,
           active_pane=excluded.active_pane,
           updated_at=excluded.updated_at",
        params![runbox_id, layout_json, active_pane, now_ms()],
    )?;
    Ok(())
}

pub fn layout_get(db: &Db, runbox_id: &str) -> Result<Option<PaneLayout>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT runbox_id, layout_json, active_pane, updated_at
         FROM pane_layouts WHERE runbox_id=?1"
    )?;
    let mut rows = stmt.query_map(params![runbox_id], |r| Ok(PaneLayout {
        runbox_id:   r.get(0)?,
        layout_json: r.get(1)?,
        active_pane: r.get(2)?,
        updated_at:  r.get(3)?,
    }))?;
    Ok(rows.next().transpose()?)
}

// ── Session events CRUD ───────────────────────────────────────────────────

/// Insert one event and update the FTS5 index automatically via trigger.
pub fn event_insert(
    db:         &Db,
    runbox_id:  &str,
    session_id: &str,
    event_type: &str,
    summary:    &str,
    detail:     Option<&str>,
) -> Result<()> {
    let id  = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO session_events (id, runbox_id, session_id, event_type, summary, detail, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, runbox_id, session_id, event_type, summary, detail, now],
    )?;
    Ok(())
}

/// BM25 full-text search over events for a runbox.
/// Falls back to `events_recent` when the query is empty or produces no hits.
pub fn events_search(db: &Db, runbox_id: &str, query: &str, limit: usize) -> Result<Vec<SessionEvent>> {
    if query.trim().is_empty() {
        return events_recent(db, runbox_id, limit);
    }

    // Sanitise the FTS5 query: strip special chars that would cause parse errors
    let safe_query = query
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-')
        .collect::<String>();

    if safe_query.trim().is_empty() {
        return events_recent(db, runbox_id, limit);
    }

    // Scope conn + stmt so they drop before the fallback call below.
    let results: Vec<SessionEvent> = {
        let conn = db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT e.id, e.runbox_id, e.session_id, e.event_type, e.summary, e.detail, e.timestamp
             FROM session_events e
             JOIN session_events_fts fts ON e.rowid = fts.rowid
             WHERE e.runbox_id = ?1
               AND session_events_fts MATCH ?2
             ORDER BY bm25(session_events_fts)
             LIMIT ?3"
        )?;
        let rows = stmt.query_map(
            params![runbox_id, safe_query, limit as i64],
            event_from_row,
        )?;
        rows.filter_map(|r| r.ok()).collect()
    }; // conn and stmt drop here, releasing the mutex lock

    // If BM25 returned nothing (rare with porter tokeniser), fall back to recents
    if results.is_empty() {
        return events_recent(db, runbox_id, limit);
    }

    Ok(results)
}

/// Most-recent N events for a runbox — used as fallback when FTS has no query.
pub fn events_recent(db: &Db, runbox_id: &str, limit: usize) -> Result<Vec<SessionEvent>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, runbox_id, session_id, event_type, summary, detail, timestamp
         FROM session_events
         WHERE runbox_id = ?1
         ORDER BY timestamp DESC
         LIMIT ?2"
    )?;
    let rows = stmt.query_map(params![runbox_id, limit as i64], event_from_row)?;
    rows.collect()
}

/// All events for a session (used for session-end summaries).
pub fn events_for_session(db: &Db, session_id: &str, limit: usize) -> Result<Vec<SessionEvent>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, runbox_id, session_id, event_type, summary, detail, timestamp
         FROM session_events
         WHERE session_id = ?1
         ORDER BY timestamp DESC
         LIMIT ?2"
    )?;
    let rows = stmt.query_map(params![session_id, limit as i64], event_from_row)?;
    rows.collect()
}

fn event_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionEvent> {
    Ok(SessionEvent {
        id:         r.get(0)?,
        runbox_id:  r.get(1)?,
        session_id: r.get(2)?,
        event_type: r.get(3)?,
        summary:    r.get(4)?,
        detail:     r.get(5)?,
        timestamp:  r.get(6)?,
    })
}