fn main() {
    let url = std::env::args().nth(1).unwrap_or_default();
    if url.is_empty() { return; }
    let _ = reqwest::blocking::Client::new()
        .post("http://localhost:7547/open-url")
        .body(url)
        .send();
}