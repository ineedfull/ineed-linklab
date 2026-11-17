// Migration ledger and schema verification.
use super::*;

pub(super) fn apply_migrations(connection: &Connection) -> DbResult<()> {
    let tables = schema_tables(connection)?;
    if tables.is_empty() {
        for migration in MIGRATIONS {
            connection.execute_batch(migration.sql).map_err(db_error)?;
        }
        return verify_migration_schema(connection);
    }
    if !tables.iter().any(|table| table == "schema_migrations") {
        return Err("migration ledger is missing from an existing database".into());
    }

    let mut statement = connection
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if rows.is_empty() {
        return Err("migration ledger is empty".into());
    }
    if let Some((version, _)) = rows
        .iter()
        .find(|(version, _)| *version > MIGRATIONS.last().unwrap().version)
    {
        return Err(format!(
            "migration ledger contains unknown version {version}"
        ));
    }
    if rows.len() > MIGRATIONS.len() {
        return Err(format!(
            "migration ledger contains unknown version {}",
            rows.last().unwrap().0
        ));
    }
    for (index, (version, name)) in rows.iter().enumerate() {
        let expected = &MIGRATIONS[index];
        if *version != expected.version || name != expected.name {
            return Err(format!(
                "migration ledger entry {} must be {}:{}",
                index + 1,
                expected.version,
                expected.name
            ));
        }
    }
    drop(statement);
    for migration in MIGRATIONS.iter().skip(rows.len()) {
        connection.execute_batch(migration.sql).map_err(|error| {
            format!(
                "migration schema update {}:{} failed: {}",
                migration.version,
                migration.name,
                db_error(error)
            )
        })?;
    }
    verify_migration_schema(connection)
}

pub(super) fn schema_tables(connection: &Connection) -> DbResult<Vec<String>> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(db_error)?;
    let tables = statement
        .query_map([], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(tables)
}

pub(super) fn verify_migration_schema(connection: &Connection) -> DbResult<()> {
    let tables = schema_tables(connection)?;
    let missing = REQUIRED_SCHEMA_TABLES
        .iter()
        .filter(|expected| !tables.iter().any(|table| table == **expected))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "migration schema is incomplete; missing: {}",
            missing.join(", ")
        ))
    }
}
