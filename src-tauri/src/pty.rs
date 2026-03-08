use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc; // Use mpsc instead of broadcast

pub struct PtySession {
    pub writer: Box<dyn std::io::Write + Send>,
    pub tx: mpsc::UnboundedSender<String>, // Swapped to UnboundedSender
}

pub type PtyMap = Arc<Mutex<HashMap<String, PtySession>>>;

pub fn create_pty_map() -> PtyMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn spawn_pty(id: String, cwd: String, map: PtyMap) -> mpsc::UnboundedReceiver<String> {
    // Unbounded channel prevents "Lagged" errors when PowerShell sends huge chunks of text
    let (tx, rx) = mpsc::unbounded_channel(); 
    let tx2 = tx.clone();

    std::thread::spawn(move || {
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: 24, cols: 80,
            pixel_width: 0, pixel_height: 0,
        }).unwrap();

        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(cmd).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();

        {
            let mut map = map.lock().unwrap();
            map.insert(id.clone(), PtySession { writer, tx: tx2 });
        }

        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = tx.send(s); // Send to mpsc channel
                }
            }
        }

        let mut map = map.lock().unwrap();
        map.remove(&id);
        child.wait().ok();
    });

    rx
}