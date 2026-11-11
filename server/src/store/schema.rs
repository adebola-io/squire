use anyhow::Result;
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

/// Sets up the database from the SQL files next to this module, in order.
/// Each file runs once (the database records which ones have run), so an
/// existing database only gets the new statements. Each file applies
/// atomically.
pub fn setup(db: &mut Connection) -> Result<()> {
    Migrations::new(vec![
        M::up(include_str!("schema/schema.sql")),
        M::up(include_str!("schema/secrets.sql")),
        M::up(include_str!("schema/auth_tokens.sql")),
        M::up_with_hook(include_str!("schema/preview_repair.sql"), |tx| {
            crate::conversations::repair_stored_previews(tx)?;
            Ok(())
        }),
        M::up(include_str!("schema/joined_run.sql")),
        M::up(include_str!("schema/desktop_sessions.sql")),
        M::up(include_str!("schema/client_message_id.sql")),
        M::up(include_str!("schema/drop_desktop_sessions.sql")),
        M::up(include_str!("schema/drop_local_mcp_auth.sql")),
        M::up(include_str!("schema/drop_edit_floor.sql")),
        M::up(include_str!("schema/thread_activity.sql")),
    ])
    .to_latest(db)?;
    Ok(())
}
