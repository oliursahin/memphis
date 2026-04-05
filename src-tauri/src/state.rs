use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub data_dir: PathBuf,
    pub sync_stop: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self, crate::error::Error> {
        let db_path = data_dir.join("memphis.db");
        std::fs::create_dir_all(&data_dir)?;

        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        Ok(Self {
            db: Arc::new(Mutex::new(conn)),
            data_dir,
            sync_stop: Arc::new(AtomicBool::new(false)),
        })
    }
}
