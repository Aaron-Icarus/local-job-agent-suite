const { getSettings } = require("./settings_repo");
const { createNotification } = require("./notifier");
const logger = require("./logger");

let runtime = { running: false };

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
     ORDER BY j.last_seen_date ASC, j.display_id ASC`
  ).all(`-${age} day`, `-${age} day`, `-${interval} hour`);
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

function hasRunningTask(db) {
  return Number(
    db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('running','retrying')").get().count || 0
  ) > 0;
}

function createBatch(db, total) {
  const result = db.prepare(
    "INSERT INTO job_recheck_batches(started_at, status, total_count) VALUES(?, 'running', ?)"
  ).run(nowSql(), total);
  return Number(result.lastInsertRowid);
}

function updateBatch(db, batchId, fields) {
  const allowed = ["finished_at", "status", "total_count", "checked_count", "closed_count", "skipped_count", "error"];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  db.prepare(`UPDATE job_recheck_batches SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), batchId);
}

async function processBatch(db, batchId, rows, options = {}) {
  const checker = options.checker || defaultChecker;
  let completed = 0;
  let closed = 0;
  let skipped = 0;
  const details = [];
  for (const job of rows) {
    if (options.isCanceled?.()) {
      updateBatch(db, batchId, { status: "canceled", finished_at: nowSql(), checked_count: completed, closed_count: closed, skipped_count: skipped });
      logger.warn("job_recheck", "历史岗位确认被中断", { batchId, completed, total: rows.length });
      return { canceled: true, batch: { id: batchId, checked: completed, total: rows.length, closed, skipped }, details };
    }
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
    completed += 1;
    details.push({ displayId: job.display_id, status, evidence: result?.evidence || "" });
    updateBatch(db, batchId, { checked_count: completed, closed_count: closed, skipped_count: skipped });
    options.onProgress?.({
      running: true,
      batchId,
      total: rows.length,
      completed,
      pending: rows.length - completed,
      closed,
      skipped,
      percent: rows.length ? Math.round((completed / rows.length) * 100) : 100,
    });
  }
  const finishedAt = nowSql();
  updateBatch(db, batchId, {
    status: "finished",
    finished_at: finishedAt,
    checked_count: completed,
    closed_count: closed,
    skipped_count: skipped,
  });
  createNotification(db, {
    type: "job_recheck",
    title: "历史岗位确认完成",
    body: `共检查 ${completed} 个岗位，关闭 ${closed} 个，无法确认 ${skipped} 个。`,
    channels: ["toast", "tray"],
  });
  logger.info("job_recheck", "历史岗位确认完成", { batchId, checked: completed, closed, skipped });
  return {
    canceled: false,
    batch: { id: batchId, startedAt: runtime.startedAt || "", finishedAt, checked: completed, total: rows.length, closed, skipped },
    details,
  };
}

async function runRecheck(db, options = {}) {
  const rows = candidates(db, options);
  const batchId = createBatch(db, rows.length);
  return processBatch(db, batchId, rows, options);
}

function startRecheck(db, options = {}) {
  if (runtime.running) return { started: false, reason: "already_running", status: getStatus() };
  if (hasRunningTask(db)) return { started: false, reason: "other_task", status: getStatus() };
  const rows = candidates(db, options);
  if (!rows.length) {
    return { started: false, reason: "no_candidates", status: getStatus() };
  }
  const batchId = createBatch(db, rows.length);
  runtime = {
    running: true,
    batchId,
    total: rows.length,
    completed: 0,
    closed: 0,
    skipped: 0,
    startedAt: nowSql(),
    cancelRequested: false,
    finished: false,
    canceled: false,
  };
  const task = processBatch(db, batchId, rows, {
    ...options,
    isCanceled: () => runtime.cancelRequested,
    onProgress: (progress) => {
      runtime = { ...runtime, ...progress, running: true };
    },
  });
  task
    .then((result) => {
      if (result.canceled) {
        runtime = { running: false, canceled: true, finished: false };
      } else {
        runtime = {
          running: false,
          finished: true,
          canceled: false,
          batchId,
          total: result.batch.total,
          completed: result.batch.checked,
          pending: 0,
          closed: result.batch.closed,
          skipped: result.batch.skipped,
          percent: 100,
        };
      }
    })
    .catch((error) => {
      updateBatch(db, batchId, { status: "failed", finished_at: nowSql(), error: error.message });
      logger.error("job_recheck", error.message, { batchId });
      runtime = { running: false, finished: false, canceled: false, error: error.message };
    });
  return { started: true, batchId, total: rows.length, status: getStatus() };
}

function cancelRecheck() {
  if (!runtime.running) return { canceled: false, status: getStatus() };
  runtime.cancelRequested = true;
  return { canceled: true, status: getStatus() };
}

function getStatus() {
  if (!runtime.running) {
    return {
      running: false,
      finished: Boolean(runtime.finished),
      canceled: Boolean(runtime.canceled),
      error: runtime.error || "",
      ...(runtime.finished
        ? {
            batchId: runtime.batchId,
            total: runtime.total,
            completed: runtime.completed,
            pending: 0,
            closed: runtime.closed,
            skipped: runtime.skipped,
            percent: 100,
          }
        : {}),
    };
  }
  return { ...runtime, pending: Math.max(0, runtime.total - runtime.completed), percent: runtime.total ? Math.round((runtime.completed / runtime.total) * 100) : 0 };
}

function listBatches(db, limit = 20) {
  return db.prepare("SELECT * FROM job_recheck_batches ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit || 20))));
}

module.exports = { candidates, runRecheck, startRecheck, cancelRecheck, getStatus, listBatches, defaultChecker };
