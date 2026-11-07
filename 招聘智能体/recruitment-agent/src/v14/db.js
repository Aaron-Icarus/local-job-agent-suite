const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "v1.4", "jobs.db");

function resolveDbPath(filePath = "") {
  return path.resolve(filePath || process.env.V14_DB_PATH || DEFAULT_DB_PATH);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function applySchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  ensureColumn(db, "roles", "resume_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "chat_sessions", "external_key", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "feishu_groups", "is_default", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "feishu_groups", "reply_role_uuid", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "last_recheck_at", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_external ON chat_sessions(external_key) WHERE external_key <> ''");
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function openDatabase(filePath = "") {
  const resolved = resolveDbPath(filePath);
  ensureParent(resolved);
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applySchema(db);
  return { db, path: resolved };
}

function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure, original error is more useful
    }
    throw error;
  }
}

function getMeta(db, key, fallback = "") {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

module.exports = {
  DEFAULT_DB_PATH,
  resolveDbPath,
  openDatabase,
  withTransaction,
  getMeta,
  setMeta,
};
