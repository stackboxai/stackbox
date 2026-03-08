use axum::{
    extract::Query,
    response::{IntoResponse, Response},
    http::{HeaderMap, StatusCode},
};
use std::collections::HashMap;

pub async fn proxy_handler(
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let url = match params.get("url") {
        Some(u) => u.clone(),
        None => return (StatusCode::BAD_REQUEST, "missing url").into_response(),
    };

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap();

    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let mut headers = HeaderMap::new();
            for (k, v) in resp.headers() {
                if k != "x-frame-options" && k != "content-security-policy" {
                    headers.insert(k.clone(), v.clone());
                }
            }
            let body = resp.bytes().await.unwrap_or_default();
            (status, headers, body).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("proxy error: {}", e),
        ).into_response(),
    }
}
