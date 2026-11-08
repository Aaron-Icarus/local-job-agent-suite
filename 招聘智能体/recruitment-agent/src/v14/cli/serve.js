#!/usr/bin/env node
const path = require("path");
const { openDatabase } = require("../db");
const { startServer } = require("../app_server");
const { startTaskWorker } = require("../task_runner");
const { backfillJobUrls } = require("../jobs_repo");
const keywordService = require("../keyword_service");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const dbPath = argValue("db", process.env.V14_DB_PATH || "");
  const port = Number(argValue("port", process.env.V14_PORT || "0"));
  const { db, path: resolved } = openDatabase(dbPath);
  backfillJobUrls(db);
  keywordService.ensureAllFallbacks(db);
  const server = await startServer(db, { port });
  const worker = startTaskWorker(db);
  console.log(JSON.stringify({ ok: true, url: server.url, db: resolved, taskWorker: true }, null, 2));
  const shutdown = async () => {
    worker.stop();
    await server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { main };
