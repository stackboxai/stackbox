// src-tauri/src/memory.rs
// LanceDB — agent memory per runbox (text only, embeddings added later)

use lancedb::{connect, Connection, Table};
use lancedb::query::{ExecutableQuery, QueryBase};
use futures::TryStreamExt;
use arrow_array::{RecordBatch, RecordBatchIterator, StringArray, Int64Array, BooleanArray};
use arrow_schema::{DataType, Field, Schema};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::OnceCell;

// ── Schema ────────────────────────────────────────────────────────────────

fn memory_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id",         DataType::Utf8,    false),
        Field::new("runbox_id",  DataType::Utf8,    false),
        Field::new("session_id", DataType::Utf8,    false),
        Field::new("content",    DataType::Utf8,    false),
        Field::new("pinned",     DataType::Boolean, false),
        Field::new("timestamp",  DataType::Int64,   false),
    ]))
}

// ── Row type ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Memory {
    pub id:         String,
    pub runbox_id:  String,
    pub session_id: String,
    pub content:    String,
    pub pinned:     bool,
    pub timestamp:  i64,
}

// ── Connection handle ─────────────────────────────────────────────────────

static DB: OnceCell<Connection> = OnceCell::const_new();

fn db_dir() -> String {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("stackbox").join("memory")
        .to_string_lossy()
        .to_string()
}

pub async fn init() -> Result<(), String> {
    let dir = db_dir();
    std::fs::create_dir_all(&dir).ok();
    let conn = connect(&dir).execute().await.map_err(|e| e.to_string())?;

    let tables = conn.table_names().execute().await.map_err(|e| e.to_string())?;
    if !tables.contains(&"memories".to_string()) {
        let schema = memory_schema();
        let batch = RecordBatch::new_empty(schema.clone());
        let reader = RecordBatchIterator::new(vec![Ok(batch)], schema);
        conn.create_table("memories", reader)
            .execute()
            .await
            .map_err(|e| e.to_string())?;
    }

    DB.set(conn).map_err(|_| "memory db already initialised".to_string())?;
    Ok(())
}

fn get_conn() -> Result<&'static Connection, String> {
    DB.get().ok_or_else(|| "memory db not initialised — call init() first".to_string())
}

async fn get_table() -> Result<Table, String> {
    get_conn()?
        .open_table("memories")
        .execute()
        .await
        .map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── Write ─────────────────────────────────────────────────────────────────

pub async fn memory_add(
    runbox_id: &str,
    session_id: &str,
    content: &str,
) -> Result<Memory, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now_ms();

    let schema = memory_schema();
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(StringArray::from(vec![id.as_str()])),
            Arc::new(StringArray::from(vec![runbox_id])),
            Arc::new(StringArray::from(vec![session_id])),
            Arc::new(StringArray::from(vec![content])),
            Arc::new(BooleanArray::from(vec![false])),
            Arc::new(Int64Array::from(vec![ts])),
        ],
    ).map_err(|e| e.to_string())?;

    let reader = RecordBatchIterator::new(vec![Ok(batch)], schema);
    get_table().await?
        .add(reader)
        .execute()
        .await
        .map_err(|e: lancedb::Error| e.to_string())?;

    Ok(Memory {
        id, runbox_id: runbox_id.to_string(), session_id: session_id.to_string(),
        content: content.to_string(),
        pinned: false, timestamp: ts,
    })
}

// ── Read ──────────────────────────────────────────────────────────────────

pub async fn memories_for_runbox(runbox_id: &str) -> Result<Vec<Memory>, String> {
    let table = get_table().await?;
    let stream = table
        .query()
        .only_if(format!("runbox_id = '{}'", runbox_id.replace('\'', "''")))
        .execute()
        .await
        .map_err(|e: lancedb::Error| e.to_string())?;

    let batches: Vec<RecordBatch> = stream
        .try_collect::<Vec<RecordBatch>>()
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for batch in &batches {
        let ids        = batch.column(0).as_any().downcast_ref::<StringArray>().unwrap();
        let runbox_ids = batch.column(1).as_any().downcast_ref::<StringArray>().unwrap();
        let sess_ids   = batch.column(2).as_any().downcast_ref::<StringArray>().unwrap();
        let contents   = batch.column(4).as_any().downcast_ref::<StringArray>().unwrap();
        let pinneds    = batch.column(5).as_any().downcast_ref::<BooleanArray>().unwrap();
        let timestamps = batch.column(6).as_any().downcast_ref::<Int64Array>().unwrap();

        for i in 0..batch.num_rows() {
            out.push(Memory {
                id:         ids.value(i).to_string(),
                runbox_id:  runbox_ids.value(i).to_string(),
                session_id: sess_ids.value(i).to_string(),
                content:    contents.value(i).to_string(),
                pinned:     pinneds.value(i),
                timestamp:  timestamps.value(i),
            });
        }
    }

    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

// ── Delete ────────────────────────────────────────────────────────────────

pub async fn memory_delete(id: &str) -> Result<(), String> {
    get_table().await?
        .delete(&format!("id = '{}'", id.replace('\'', "''")))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub async fn memories_delete_for_runbox(runbox_id: &str) -> Result<(), String> {
    get_table().await?
        .delete(&format!("runbox_id = '{}'", runbox_id.replace('\'', "''")))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}


pub async fn memory_pin(id: &str, pinned: bool) -> Result<(), String> {
    let table = get_table().await?;

    let stream = table
        .query()
        .only_if(format!("id = '{}'", id.replace('\'', "''")))
        .execute()
        .await
        .map_err(|e: lancedb::Error| e.to_string())?;

    let batches: Vec<RecordBatch> = stream
        .try_collect::<Vec<RecordBatch>>()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(batch) = batches.into_iter().next() {
        if batch.num_rows() == 0 { return Ok(()); }

        let ids        = batch.column(0).as_any().downcast_ref::<StringArray>().unwrap();
        let runbox_ids = batch.column(1).as_any().downcast_ref::<StringArray>().unwrap();
        let sess_ids   = batch.column(2).as_any().downcast_ref::<StringArray>().unwrap();
        let agents     = batch.column(3).as_any().downcast_ref::<StringArray>().unwrap();
        let contents   = batch.column(4).as_any().downcast_ref::<StringArray>().unwrap();
        let timestamps = batch.column(6).as_any().downcast_ref::<Int64Array>().unwrap();

        table
            .delete(&format!("id = '{}'", id.replace('\'', "''")))
            .await
            .map_err(|e| e.to_string())?;

        let schema = memory_schema();
        let new_batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec![ids.value(0)])),
                Arc::new(StringArray::from(vec![runbox_ids.value(0)])),
                Arc::new(StringArray::from(vec![sess_ids.value(0)])),
                Arc::new(StringArray::from(vec![agents.value(0)])),
                Arc::new(StringArray::from(vec![contents.value(0)])),
                Arc::new(BooleanArray::from(vec![pinned])),
                Arc::new(Int64Array::from(vec![timestamps.value(0)])),
            ],
        ).map_err(|e| e.to_string())?;

        let reader = RecordBatchIterator::new(vec![Ok(new_batch)], schema);
        get_table().await?
            .add(reader)
            .execute()
            .await
            .map_err(|e: lancedb::Error| e.to_string())?;
    }

    Ok(())
}