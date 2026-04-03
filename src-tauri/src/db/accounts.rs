use rusqlite::Connection;

use crate::error::Error;
use crate::models::account::Account;

pub fn get_accounts(conn: &Connection) -> Result<Vec<Account>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, email, display_name, avatar_url, provider, is_active, created_at, updated_at
         FROM accounts WHERE is_active = 1 ORDER BY created_at ASC",
    )?;

    let accounts = stmt
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                email: row.get(1)?,
                display_name: row.get(2)?,
                avatar_url: row.get(3)?,
                provider: row.get(4)?,
                is_active: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(accounts)
}
