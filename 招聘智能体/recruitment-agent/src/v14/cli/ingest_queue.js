#!/usr/bin/env node
const { openDatabase } = require("../db");
const { processRawQueue } = require("../ingest_service");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function main() {
  const dbPath = argValue("db", process.env.V14_DB_PATH || "");
  const outputsDir = argValue("outputs", "");
  const limit = Number(argValue("limit", "50")) || 50;
  const { db, path: resolvedDb } = openDatabase(dbPath);
  try {
    const summary = processRawQueue(db, {
      outputsDir: outputsDir || undefined,
      limit,
      discover: !hasFlag("no-discover"),
    });
    console.log(JSON.stringify({ ok: summary.failed === 0, db: resolvedDb, ...summary }, null, 2));
    process.exitCode = summary.failed === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { main };
