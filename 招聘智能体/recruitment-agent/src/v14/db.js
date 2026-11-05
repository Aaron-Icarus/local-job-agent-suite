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
