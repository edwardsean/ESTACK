import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;

export const MIGRATION_1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, goal TEXT NOT NULL,
  done_check TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL, cwd TEXT NOT NULL,
  base_sha TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE task_bindings (
  task_id INTEGER NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL, agent_id TEXT,
  role TEXT NOT NULL, bound_at TEXT NOT NULL
);
CREATE TABLE steps (
  task_id INTEGER NOT NULL REFERENCES tasks(id), name TEXT NOT NULL, ordinal INTEGER NOT NULL,
  status TEXT NOT NULL, done_at TEXT, PRIMARY KEY (task_id, name)
);
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), step TEXT NOT NULL,
  kind TEXT NOT NULL, ok INTEGER NOT NULL, payload_json TEXT NOT NULL,
  recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), action TEXT NOT NULL,
  command TEXT NOT NULL, decision TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
  task_id INTEGER, payload_json TEXT NOT NULL
);
`;

export const MIGRATION_2 = `
CREATE TABLE handovers (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, task_id INTEGER REFERENCES tasks(id),
  from_session TEXT NOT NULL, created_at TEXT NOT NULL, auto INTEGER NOT NULL, body_json TEXT NOT NULL,
  consumed_by TEXT, consumed_at TEXT
);
`;

export const MIGRATION_3 = `
CREATE TABLE code_queries (
  id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), tool TEXT NOT NULL,
  input TEXT NOT NULL, result_json TEXT NOT NULL, ok INTEGER NOT NULL, auto INTEGER NOT NULL,
  graph_version TEXT, checkout TEXT NOT NULL, recorded_by TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE duplicates (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), commit_sha TEXT NOT NULL,
  new_symbol TEXT NOT NULL, new_file TEXT NOT NULL, new_line INTEGER NOT NULL,
  existing_symbol TEXT NOT NULL, existing_file TEXT NOT NULL, existing_line INTEGER NOT NULL,
  status TEXT NOT NULL, reason TEXT, closed_by TEXT, found_at TEXT NOT NULL, closed_at TEXT,
  UNIQUE (task_id, new_file, new_symbol, existing_file, existing_symbol)
);
CREATE INDEX events_kind_task_actor ON events(kind, task_id, actor);
CREATE INDEX code_queries_task_actor ON code_queries(task_id, recorded_by);
`;

const MIGRATIONS = [MIGRATION_1, MIGRATION_2, MIGRATION_3];

/** Open (creating if needed) the state database, apply pragmas and pending migrations. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get();
  let current = 0;
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    current = row ? Number(row.value) : 0;
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another process may have migrated meanwhile.
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get();
      const row = has ? db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined : undefined;
      if (!row || Number(row.value) <= v) {
        db.exec(MIGRATIONS[v]);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(v + 1));
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}
