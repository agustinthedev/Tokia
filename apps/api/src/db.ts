import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { runMigrations } from './migrations.js';

export function createDatabase(databasePath = config.databasePath): Database.Database {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
  runMigrations(db, migrationsDirectory);
  return db;
}
