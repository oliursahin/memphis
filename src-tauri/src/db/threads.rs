use rusqlite::Connection;

use crate::error::Error;
use crate::models::thread::{ThreadSummary, ThreadDetail};

pub fn list_threads(
    conn: &Connection,
    account_id: &str,
    category: Option<&str>,
    page: u32,
    per_page: u32,
) -> Result<(Vec<ThreadSummary>, u64), Error> {
    let offset = (page.saturating_sub(1)) * per_page;

    let (where_clause, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match category {
        Some(cat) => (
            "WHERE t.account_id = ?1 AND t.is_archived = 0 AND t.is_trashed = 0 AND t.category = ?2".into(),
            vec![Box::new(account_id.to_string()), Box::new(cat.to_string())],
        ),
        None => (
            "WHERE t.account_id = ?1 AND t.is_archived = 0 AND t.is_trashed = 0".into(),
            vec![Box::new(account_id.to_string())],
        ),
    };

    let count_sql = format!("SELECT COUNT(*) FROM threads t {where_clause}");
    let total: u64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        |row| row.get(0),
    )?;

    let query = format!(
        "SELECT t.id, t.subject, t.snippet, t.last_message_at, t.message_count,
                t.is_read, t.is_starred, t.category
         FROM threads t
         {where_clause}
         ORDER BY t.last_message_at DESC
         LIMIT ?{} OFFSET ?{}",
        params.len() + 1,
        params.len() + 2,
    );

    let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = params;
    all_params.push(Box::new(per_page));
    all_params.push(Box::new(offset));

    let mut stmt = conn.prepare(&query)?;
    let threads = stmt
        .query_map(
            rusqlite::params_from_iter(all_params.iter().map(|p| p.as_ref())),
            |row| {
                Ok(ThreadSummary {
                    id: row.get(0)?,
                    subject: row.get(1)?,
                    snippet: row.get(2)?,
                    last_message_at: row.get(3)?,
                    message_count: row.get(4)?,
                    is_read: row.get(5)?,
                    is_starred: row.get(6)?,
                    category: row.get(7)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;

    Ok((threads, total))
}

pub fn get_thread(_conn: &Connection, _thread_id: &str) -> Result<ThreadDetail, Error> {
    todo!("Implement in Phase 5")
}
