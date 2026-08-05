import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database, migrationsDirectory = path.resolve(process.cwd(), 'migrations')): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const files = fs.readdirSync(migrationsDirectory)
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort();
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>)
    .map((row) => row.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDirectory, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    apply();
  }
}
