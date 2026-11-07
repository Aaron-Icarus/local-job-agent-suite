const { getSettings } = require("./settings_repo");
const logger = require("./logger");

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function settingNumber(settings, key, fallback) {
  const value = Number(settings?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function candidates(db, options = {}) {
  const settings = options.settings || getSettings(db);
  const age = Number(options.minAgeDays || settingNumber(settings, "recheck_min_age_days", 7));
  const interval = Number(options.intervalHours || settingNumber(settings, "recheck_interval_hours", 24));
  return db.prepare(
    `SELECT j.*, date('now', ?) AS cutoff_date
     FROM jobs j
     WHERE j.job_status <> 'closed'
       AND j.last_seen_date IS NOT NULL
       AND j.last_seen_date <= date('now', ?)
       AND (j.last_recheck_at IS NULL OR j.last_recheck_at <= datetime('now', ?))
     ORDER BY j.last_seen_date ASC, j.display_id ASC
     LIMIT ?`
  ).all(`-${age} day`, `-${age} day`, `-${interval} hour`, Math.max(1, Math.min(200, Number(options.limit || 20))));
}

async function defaultChecker(job) {
  if (!job.job_url) return { status: "unknown", evidence: "缺少岗位链接" };
  try {
    const response = await fetch(job.job_url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 JobAgent/1.5" },
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 404 || response.status === 410) {
      return { status: "missing", evidence: `HTTP ${response.status}` };
    }
    if (!response.ok) return { status: "unknown", evidence: `HTTP ${response.status}` };
    const text = (await response.text()).slice(0, 200000);
    if (/职位已关闭|职位已下线|该职位已结束|停止招聘|职位不存在|no longer available|job is closed/i.test(text)) {
      return { status: "missing", evidence: "页面包含关闭/下架标记" };
    }
    return { status: "unknown", evidence: "页面可访问，未发现关闭标记" };
  } catch (error) {
    return { status: "unknown", evidence: error.message };
  }
}

async function runRecheck(db, options = {}) {
  const checker = options.checker || defaultChecker;
  const settings = options.settings || getSettings(db);
  const startedAt = nowSql();
  const created = db.prepare(
    "INSERT INTO job_recheck_batches(started_at, status) VALUES(?, 'running')"
  ).run(startedAt);
  const batchId = created.lastInsertRowid;
  const rows = candidates(db, { ...options, settings });
  let closed = 0;
  let skipped = 0;
  const details = [];
  for (const job of rows) {
    const checkedAt = nowSql();
    let result;
    try {
      result = await checker(job);
    } catch (error) {
      result = { status: "unknown", evidence: error.message };
    }
    const status = result?.status || "unknown";
    db.prepare("UPDATE jobs SET last_recheck_at = ? WHERE job_uuid = ?").run(checkedAt, job.job_uuid);
    if (status === "missing") {
      db.prepare(
        "UPDATE jobs SET job_status = 'closed', status_updated_at = ?, closed_at = ? WHERE job_uuid = ?"
      ).run(checkedAt, checkedAt, job.job_uuid);
      closed += 1;
    } else if (status !== "open") {
      skipped += 1;
    }
    details.push({ displayId: job.display_id, status, evidence: result?.evidence || "" });
  }
  const finishedAt = nowSql();
  db.prepare(
    `UPDATE job_recheck_batches SET finished_at = ?, status = 'finished',
       checked_count = ?, closed_count = ?, skipped_count = ? WHERE id = ?`
  ).run(finishedAt, rows.length, closed, skipped, batchId);
  logger.info("job_recheck", "历史岗位确认完成", { batchId, checked: rows.length, closed, skipped, startedAt, finishedAt });
  return {
    batch: { id: Number(batchId), startedAt, finishedAt, checked: rows.length, closed, skipped },
    details,
  };
}

function listBatches(db, limit = 20) {
  return db.prepare("SELECT * FROM job_recheck_batches ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit || 20))));
}

module.exports = { candidates, runRecheck, listBatches, defaultChecker };
