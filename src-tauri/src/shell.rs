use axum::{
    extract::State,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
use crate::ws::AppState;
use crate::pty::spawn_pty;

#[derive(Deserialize)]
pub struct SpawnRequest {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Serialize)]
pub struct SpawnResponse {
    pub session_id: String,
}

pub async fn shell_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SpawnRequest>,
) -> impl IntoResponse {
    let session_id = Uuid::new_v4().to_string();
    let cwd = req.cwd.unwrap_or_else(|| ".".to_string());

    spawn_pty(session_id.clone(), cwd, state.pty_map.clone());

    Json(SpawnResponse { session_id })
}
