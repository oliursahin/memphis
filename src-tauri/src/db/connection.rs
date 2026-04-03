use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::Error;

/// Execute a database operation on a background thread to avoid blocking the async runtime.
/// Takes the shared connection and a closure that operates on it.
pub async fn with_db<F, T>(db: &Arc<Mutex<Connection>>, f: F) -> Result<T, Error>
where
    F: FnOnce(&Connection) -> Result<T, Error> + Send + 'static,
    T: Send + 'static,
{
    let db = Arc::clone(db);
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| Error::Internal(format!("DB lock poisoned: {e}")))?;
        f(&conn)
    })
    .await
    .map_err(|e| Error::Internal(format!("spawn_blocking failed: {e}")))?
}
