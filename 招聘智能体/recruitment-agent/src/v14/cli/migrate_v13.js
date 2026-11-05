#!/usr/bin/env node
const path = require("path");
const { openDatabase } = require("../db");
const { migrateV13Store } = require("../migrate_v13");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function main() {
  const root = path.resolve(__dirname, "..", "..", "..");
  const storePath = argValue("store", path.join(root, "data", "job_store.json"));
  const dbPath = argValue("db", process.env.V14_DB_PATH || "");
  const { db, path: resolvedDb } = openDatabase(dbPath);
  try {
    const result = migrateV13Store(db, storePath);
    console.log(JSON.stringify({ ok: result.failed === 0, db: resolvedDb, store: storePath, ...result }, null, 2));
    process.exitCode = result.failed === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { main };
