import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

/** Runs fn in a write transaction. Takes the write lock up front, so it cannot fail on upgrade. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite may already have rolled back on its own; the original error is the one that matters.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function applyMigrations(db: DatabaseSync): void {
  // Read inside the write lock, so two processes opening a new file cannot both migrate it.
  transaction(db, () => {
    const current = userVersion(db);
    if (current > MIGRATIONS.length) {
      throw new Error(
        `Database is at version ${current}, newer than this build (${MIGRATIONS.length})`,
      );
    }
    for (const migration of MIGRATIONS.slice(current)) db.exec(migration);
    // PRAGMA takes no bound parameters; this value is the integer length of a constant.
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });
}

/** Opens (creating if needed) and migrates the database. `path` may be ':memory:'. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // busy_timeout first: switching to WAL can itself need to wait for another connection.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
