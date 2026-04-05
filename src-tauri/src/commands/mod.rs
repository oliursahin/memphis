pub mod auth;
pub mod compose;
pub mod inbox;
pub mod labels;
pub mod search;
pub mod settings;
pub mod sync;
pub mod unsplash;

/// Smoke test command for Phase 1 verification.
#[tauri::command]
pub fn ping() -> String {
    "ping".to_string()
}
