use tauri::State;

use crate::error::Error;
use crate::state::AppState;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitConfig {
    pub id: String,
    pub name: String,
    pub gmail_label_id: Option<String>,
    pub query: Option<String>,
}

#[tauri::command]
pub async fn save_splits(state: State<'_, AppState>, splits: Vec<SplitConfig>) -> Result<(), Error> {
    let json = serde_json::to_string(&splits)?;
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('splits', ?1)",
        [&json],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_splits(state: State<'_, AppState>) -> Result<Vec<SplitConfig>, Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    let result: Result<String, _> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'splits'",
        [],
        |row| row.get(0),
    );
    match result {
        Ok(json) => {
            let splits: Vec<SplitConfig> = serde_json::from_str(&json)?;
            Ok(splits)
        }
        Err(_) => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn save_setting(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<(), Error> {
    let json = serde_json::to_string(&value)?;
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [&key, &json],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_setting(state: State<'_, AppState>, key: String) -> Result<serde_json::Value, Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    let result: Result<String, _> = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [&key],
        |row| row.get(0),
    );
    match result {
        Ok(json) => Ok(serde_json::from_str(&json)?),
        Err(_) => Ok(serde_json::Value::Null),
    }
}
