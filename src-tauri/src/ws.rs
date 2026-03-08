use axum::{
    extract::{ws::{WebSocket, WebSocketUpgrade, Message}, State},
    response::Response,
};
use futures_util::{StreamExt, SinkExt};
use std::sync::Arc;
use std::io::Write;
use crate::pty::{PtyMap, spawn_pty};
use serde_json::Value;

pub struct AppState {
    pub pty_map: PtyMap,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (sink, mut stream) = socket.split();
    let sender = Arc::new(tokio::sync::Mutex::new(sink));

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(json) = serde_json::from_str::<Value>(&text) {
                    match json["type"].as_str() {
                        Some("spawn") => {
                            let session_id = json["session_id"].as_str().unwrap_or("").to_string();
                            let cwd = json["cwd"].as_str().unwrap_or(".").to_string();
                            
                            let mut rx = spawn_pty(session_id.clone(), cwd, state.pty_map.clone());
                            let sid = session_id.clone();
                            let sender = sender.clone();
                            
                            tokio::spawn(async move {
                                // THE FIX: This now correctly loops over the mpsc channel 
                                // and will never drop out early due to a broadcast lag.
                                while let Some(data) = rx.recv().await {
                                    let out = serde_json::json!({
                                        "session_id": sid,
                                        "type": "process.stdout",
                                        "payload": { "text": data }
                                    }).to_string();
                                    
                                    let mut s = sender.lock().await;
                                    if s.send(Message::Text(out.into())).await.is_err() {
                                        break;
                                    }
                                }
                            });
                        }
                        Some("input") => {
                            let id   = json["session_id"].as_str().unwrap_or("").to_string();
                            let data = json["text"].as_str().unwrap_or("").to_string();
                            let mut map = state.pty_map.lock().unwrap();
                            if let Some(session) = map.get_mut(&id) {
                                let _ = session.writer.write_all(data.as_bytes());
                                let _ = session.writer.flush();
                            }
                        }
                        _ => {}
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}