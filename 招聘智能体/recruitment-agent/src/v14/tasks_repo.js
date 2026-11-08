const { withTransaction } = require("./db");
const { nowIso } = require("./jobs_repo");

const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  RETRYING: "retrying",
  CANCELED: "canceled",
  STALLED: "stalled",
});

const PRIORITY = Object.freeze({
  REPORT: 10,
  PUSH: 10,
  SCORE: 20,
  EXPORT: 25,
  INGEST: 30,
  COLLECT: 40,
});

function createTask(db, input = {}) {
  const now = nowIso();
  const result = db.prepare(
    `INSERT INTO tasks(type, priority, status, payload_json, progress_json, checkpoint_json, attempts, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, '{}', '{}', 0, ?, ?)`
  ).run(
    String(input.type || ""),
    Number(input.priority == null ? 50 : input.priority),
    JSON.stringify(input.payload || {}),
    now,
    now
  );
  return getTask(db, result.lastInsertRowid);
}

function getTask(db, id) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    payload: safeJson(row.payload_json, {}),
    progress: safeJson(row.progress_json, {}),
    checkpoint: safeJson(row.checkpoint_json, {}),
  };
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function logTaskEvent(db, taskId, type, detail = {}) {
  db.prepare(
    "INSERT INTO task_events(task_id, event_type, detail_json, created_at) VALUES(?, ?, ?, ?)"
  ).run(taskId, type, JSON.stringify(detail), nowIso());
}

function updateTask(db, id, patch = {}) {
  const task = getTask(db, id);
  if (!task) throw new Error("任务不存在");
  const fields = [];
  const values = [];
  const columns = {
    status: "status",
    priority: "priority",
    progress: "progress_json",
    checkpoint: "checkpoint_json",
    lastError: "last_error",
    nextRetryAt: "next_retry_at",
    startedAt: "started_at",
    finishedAt: "finished_at",
    lastHeartbeatAt: "last_heartbeat_at",
  };
  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] !== undefined) {
      fields.push(`${column} = ?`);
      values.push(
        key === "progress" || key === "checkpoint" ? JSON.stringify(patch[key]) : patch[key]
      );
    }
  }
  if (!fields.length) return task;
  fields.push("updated_at = ?");
  values.push(nowIso(), id);
  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getTask(db, id);
}

function startTask(db, id, progress = {}) {
  const now = nowIso();
  return withTransaction(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error("任务不存在");
    if (!["queued", "retrying", "paused"].includes(task.status)) return task;
    const updated = updateTask(db, id, {
      status: TASK_STATUS.RUNNING,
      startedAt: task.started_at || now,
      lastHeartbeatAt: now,
      progress,
      lastError: "",
    });
    db.prepare("UPDATE tasks SET attempts = attempts + 1 WHERE id = ?").run(id);
    logTaskEvent(db, id, "started", { progress });
    return getTask(db, id);
  });
}

function heartbeat(db, id, progress = {}) {
  const task = getTask(db, id);
  if (!task) return null;
  return updateTask(db, id, { lastHeartbeatAt: nowIso(), progress });
}

function finishTask(db, id, result = {}) {
  const now = nowIso();
  return withTransaction(db, () => {
    updateTask(db, id, {
      status: TASK_STATUS.SUCCEEDED,
      finishedAt: now,
      progress: result.progress || {},
      lastHeartbeatAt: now,
      lastError: "",
    });
    logTaskEvent(db, id, "succeeded", result);
    return getTask(db, id);
  });
}

function failTask(db, id, error, options = {}) {
  const now = nowIso();
  return withTransaction(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error("任务不存在");
    const canRetry = options.retry !== false && Number(task.attempts || 0) < Number(options.maxAttempts || 3);
    updateTask(db, id, {
      status: canRetry ? TASK_STATUS.RETRYING : TASK_STATUS.FAILED,
      lastError: String(error || "").slice(0, 2000),
      nextRetryAt: canRetry ? options.nextRetryAt || "" : "",
      finishedAt: canRetry ? "" : now,
    });
    logTaskEvent(db, id, canRetry ? "retrying" : "failed", { error: String(error || "") });
    return getTask(db, id);
  });
}

function pauseTask(db, id) {
  return withTransaction(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error("任务不存在");
    if (task.status !== TASK_STATUS.RUNNING) return task;
    updateTask(db, id, { status: TASK_STATUS.PAUSED });
    logTaskEvent(db, id, "paused", {});
    return getTask(db, id);
  });
}

function resumeTask(db, id) {
  return withTransaction(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error("任务不存在");
    if (task.status !== TASK_STATUS.PAUSED) return task;
    updateTask(db, id, { status: TASK_STATUS.QUEUED });
    logTaskEvent(db, id, "resumed", {});
    return getTask(db, id);
  });
}

function cancelTask(db, id, reason = "") {
  return withTransaction(db, () => {
    const task = getTask(db, id);
    if (!task) throw new Error("任务不存在");
    updateTask(db, id, { status: TASK_STATUS.CANCELED, finishedAt: nowIso(), lastError: reason });
    logTaskEvent(db, id, "canceled", { reason });
    return getTask(db, id);
  });
}

function listTasks(db, options = {}) {
  const clauses = [];
  const params = [];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.type) {
    clauses.push("type = ?");
    params.push(options.type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  return db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority ASC, created_at DESC LIMIT ?`)
    .all(...params, limit)
    .map((row) => ({
      ...row,
      payload: safeJson(row.payload_json, {}),
      progress: safeJson(row.progress_json, {}),
      checkpoint: safeJson(row.checkpoint_json, {}),
    }));
}

function createCollectionEvent(db, input = {}) {
  const now = nowIso();
  return withTransaction(db, () => {
    const result = db.prepare(
      `INSERT INTO collection_events(event_date, status, executed, force_reason, created_at)
       VALUES (?, 'queued', 0, ?, ?)`
    ).run(String(input.eventDate || ""), String(input.forceReason || ""), now);
    const eventId = result.lastInsertRowid;
    const subtasks = [];
    for (const item of input.subtasks || []) {
      const sub = db.prepare(
        `INSERT INTO collection_subtasks(event_id, platform, role_uuid, status, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`
      ).run(eventId, String(item.platform || ""), String(item.roleUuid || ""), now, now);
      const subtaskId = sub.lastInsertRowid;
      for (const keyword of item.keywords || []) {
        db.prepare(
          `INSERT INTO keyword_tasks(subtask_id, keyword, channel, priority, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)`
        ).run(
          subtaskId,
          String(keyword.keyword || keyword),
          String(keyword.channel || item.platform || ""),
          Number(keyword.priority == null ? 50 : keyword.priority),
          now,
          now
        );
      }
      subtasks.push(subtaskId);
    }
    return getCollectionEvent(db, eventId);
  });
}

function getCollectionEvent(db, id) {
  const event = db.prepare("SELECT * FROM collection_events WHERE id = ?").get(id);
  if (!event) return null;
  return {
    ...event,
    subtasks: db.prepare("SELECT * FROM collection_subtasks WHERE event_id = ? ORDER BY id").all(id),
  };
}

function startCollectionEvent(db, id, forceReason = "") {
  return withTransaction(db, () => {
    const event = getCollectionEvent(db, id);
    if (!event) throw new Error("采集事件不存在");
    db.prepare(
      "UPDATE collection_events SET status = 'running', executed = 1, started_at = COALESCE(started_at, ?), force_reason = CASE WHEN ? = '' THEN force_reason ELSE ? END WHERE id = ?"
    ).run(nowIso(), forceReason, forceReason, id);
    return getCollectionEvent(db, id);
  });
}

function startSubtask(db, id) {
  db.prepare(
    "UPDATE collection_subtasks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?"
  ).run(nowIso(), nowIso(), id);
  return db.prepare("SELECT * FROM collection_subtasks WHERE id = ?").get(id);
}

function finishSubtask(db, id, input = {}) {
  const status = input.status || "success";
  const now = nowIso();
  db.prepare(
    `UPDATE collection_subtasks SET status = ?, stop_reason = ?, keyword_stats_json = ?,
      finished_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    status,
    String(input.stopReason || ""),
    JSON.stringify(input.keywordStats || []),
    now,
    now,
    id
  );
  return db.prepare("SELECT * FROM collection_subtasks WHERE id = ?").get(id);
}

function finishCollectionEvent(db, id) {
  const event = getCollectionEvent(db, id);
  if (!event) throw new Error("采集事件不存在");
  const success = event.subtasks.filter((item) => item.status === "success" || item.status === "partial_success").length;
  const failed = event.subtasks.filter((item) => item.status === "failed").length;
  const status = failed === 0 && success === event.subtasks.length
    ? "success"
    : success > 0
      ? "partial_success"
      : "failed";
  db.prepare(
    "UPDATE collection_events SET status = ?, success_subtasks = ?, failed_subtasks = ?, finished_at = ? WHERE id = ?"
  ).run(status, success, failed, nowIso(), id);
  return getCollectionEvent(db, id);
}

function listCollectionEvents(db, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  return db
    .prepare("SELECT * FROM collection_events ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

function countTodayExecuted(db, dateKey) {
  return Number(
    db.prepare(
      "SELECT COUNT(*) AS count FROM collection_events WHERE event_date = ? AND executed = 1"
    ).get(dateKey).count || 0
  );
}

function lastExecutedAt(db, dateKey) {
  const row = db.prepare(
    "SELECT started_at FROM collection_events WHERE event_date = ? AND executed = 1 ORDER BY started_at DESC LIMIT 1"
  ).get(dateKey);
  return row ? row.started_at : "";
}

module.exports = {
  TASK_STATUS,
  PRIORITY,
  createTask,
  getTask,
  updateTask,
  startTask,
  heartbeat,
  finishTask,
  failTask,
  pauseTask,
  resumeTask,
  cancelTask,
  listTasks,
  createCollectionEvent,
  getCollectionEvent,
  startCollectionEvent,
  startSubtask,
  finishSubtask,
  finishCollectionEvent,
  listCollectionEvents,
  countTodayExecuted,
  lastExecutedAt,
};
