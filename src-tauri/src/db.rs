// src-tauri/src/db.rs
// rusqlite — runboxes, sessions, file_changes, pane_layouts

use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// ── Public handle ─────────────────────────────────────────────────────────
pub type Db = Arc<Mutex<Connection>>;

// ── Row types (serialized to frontend) ───────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Runbox {
    pub id:           String,
    pub name:         String,
    pub cwd:          String,
    pub branch:       Option<String>,
    pub created_at:   i64,
    pub updated_at:   i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id:         String,
    pub runbox_id:  String,
    pub pane_id:    String,   // frontend pane id (e.g. "t1", "t2")
    pub agent:      String,
    pub cwd:        String,
    pub started_at: i64,
    pub ended_at:   Option<i64>,
    pub exit_code:  Option<i32>,
    pub log_path:   Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileChange {
    pub id:          i64,
    pub session_id:  String,
    pub runbox_id:   String,
    pub file_path:   String,
    pub change_type: String,  // "created" | "modified" | "deleted"
    pub diff:        Option<String>,
    pub timestamp:   i64,
}

// Stores the full pane tree JSON per runbox so layout is restored on reopen
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaneLayout {
    pub runbox_id:   String,
    pub layout_json: String,  // serialised PaneNode tree from frontend
    pub active_pane: String,
    pub updated_at:  i64,
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
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS runboxes (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            cwd           TEXT NOT NULL,
            branch        TEXT,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
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

        CREATE TABLE IF NOT EXISTS file_changes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL,
            runbox_id   TEXT NOT NULL,
            file_path   TEXT NOT NULL,
            change_type TEXT NOT NULL,
            diff        TEXT,
            timestamp   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pane_layouts (
            runbox_id   TEXT PRIMARY KEY REFERENCES runboxes(id) ON DELETE CASCADE,
            layout_json TEXT NOT NULL,
            active_pane TEXT NOT NULL DEFAULT '',
            updated_at  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_runbox   ON sessions(runbox_id);
        CREATE INDEX IF NOT EXISTS idx_filechanges_runbox ON file_changes(runbox_id);
        CREATE INDEX IF NOT EXISTS idx_filechanges_session ON file_changes(session_id);
    ")
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
        started_at: r.get(4)?,
        ended_at:   r.get(5)?,
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

// ── File changes ──────────────────────────────────────────────────────────

pub fn file_change_insert(
    db: &Db,
    session_id: &str,
    runbox_id: &str,
    file_path: &str,
    change_type: &str,
    diff: Option<&str>,
) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO file_changes (session_id, runbox_id, file_path, change_type, diff, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![session_id, runbox_id, file_path, change_type, diff, now_ms()],
    )?;
    Ok(())
}

pub fn file_changes_for_runbox(db: &Db, runbox_id: &str) -> Result<Vec<FileChange>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, session_id, runbox_id, file_path, change_type, diff, timestamp
         FROM file_changes WHERE runbox_id=?1 ORDER BY timestamp DESC LIMIT 500"
    )?;
    let rows = stmt.query_map(params![runbox_id], |r| Ok(FileChange {
        id:          r.get(0)?,
        session_id:  r.get(1)?,
        runbox_id:   r.get(2)?,
        file_path:   r.get(3)?,
        change_type: r.get(4)?,
        diff:        r.get(4)?,
        timestamp:   r.get(5)?,
    }))?;
    rows.collect()
}