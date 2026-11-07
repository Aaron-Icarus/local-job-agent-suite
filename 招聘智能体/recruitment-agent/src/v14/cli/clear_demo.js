const fs = require("fs");
const path = require("path");
const { openDatabase, withTransaction } = require("../db");
const logger = require("../logger");

const dbPath = path.resolve(process.env.V14_DB_PATH || path.join(__dirname, "..", "..", "..", "data", "v1.4", "jobs.db"));
const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;

if (fs.existsSync(dbPath)) {
  fs.copyFileSync(dbPath, backupPath);
}

const { db } = openDatabase(dbPath);
const counts = {};
withTransaction(db, () => {
  for (const table of [
    "keyword_tasks",
    "collection_subtasks",
    "collection_events",
    "task_events",
    "pending_jobs",
    "ingest_runs",
    "job_recheck_batches",
    "role_jobs",
    "chat_messages",
    "chat_sessions",
    "reports",
    "notifications",
    "login_checks",
    "tasks",
    "raw_files",
    "resumes",
    "roles",
    "jobs",
  ]) {
    counts[table] = Number(db.prepare(`DELETE FROM ${table}`).run().changes || 0);
  }
  // 保留飞书群本身，但清掉已不存在的角色绑定
  db.prepare("DELETE FROM feishu_group_roles").run();
  db.prepare("UPDATE feishu_groups SET reply_role_uuid = ''").run();
});
db.exec("VACUUM");
db.close();
logger.info("clear_demo", "已清理演示/业务数据", { backupPath, counts });
console.log(JSON.stringify({ ok: true, backupPath, counts }, null, 2));
