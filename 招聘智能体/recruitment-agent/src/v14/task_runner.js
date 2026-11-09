const { listTasks, startTask, finishTask, failTask, createTask, PRIORITY, getCollectionEvent } = require("./tasks_repo");
const { runCollectionEvent } = require("./collection_runner");
const { processRawQueue } = require("./ingest_service");
const { buildReport } = require("./report_service");
const { exportRoleToExcel, defaultExportDir } = require("./export_service");
const fs = require("fs");
const path = require("path");
const { runningRoles } = require("./task_service");
const { scoreAllRoles } = require("./score_service");
const { ensureChrome } = require("./chrome_manager");
const { getIdleStatus } = require("./system_idle");

function idleThreshold() {
  return Math.max(0, Number(process.env.V14_IDLE_THRESHOLD_SECONDS || 120));
}

function pickTask(db) {
  const rows = listTasks(db, { limit: 20 });
  return rows.find((task) => task.status === "queued" || task.status === "retrying") || null;
}

async function runTask(db, task) {
  if (task.type === "collect") {
    if (!task.payload.eventId) {
      failTask(db, task.id, "采集任务缺少 eventId", { retry: false });
      return;
    }
    const manual = String(task.payload.forceReason || "").toLowerCase() === "manual";
    if (!manual && process.env.V14_DEFER_COLLECT_ON_ACTIVE !== "false") {
      const idle = await getIdleStatus({ thresholdSeconds: idleThreshold() });
      if (idle.available && idle.active) return;
    }
    startTask(db, task.id, { eventId: task.payload.eventId });
    const chrome = await ensureChrome({ startMinimized: true, startUrl: "about:blank" });
    if (!chrome || !chrome.port) {
      failTask(db, task.id, "Chrome CDP 未就绪，无法采集", { retry: false });
      return;
    }
    await runCollectionEvent(db, task.payload.eventId, { taskId: task.id });
    const event = getCollectionEvent(db, task.payload.eventId);
    if (event && ["success", "partial_success"].includes(event.status)) {
      const existing = listTasks(db, { type: "ingest", limit: 20 })
        .some((item) => ["queued", "retrying", "running"].includes(item.status));
      if (!existing) {
        createTask(db, {
          type: "ingest",
          priority: PRIORITY.INGEST,
          payload: { dateKey: task.payload.dateKey, eventId: task.payload.eventId },
        });
      }
    }
    return;
  }

  if (task.type === "ingest") {
    startTask(db, task.id, {});
    const summary = processRawQueue(db, { discover: true });
    finishTask(db, task.id, { progress: summary });
    const pending = Number(db.prepare("SELECT COUNT(*) AS c FROM role_jobs WHERE needs_score = 1").get().c || 0);
    if (pending > 0 && !listTasks(db, { type: "score", limit: 20 }).some((item) => ["queued", "retrying", "running"].includes(item.status))) {
      createTask(db, { type: "score", priority: PRIORITY.SCORE, payload: { dateKey: task.payload.dateKey } });
    }
    return;
  }

  if (task.type === "export") {
    startTask(db, task.id, {});
    const kind = String(task.payload.kind || "excel");
    const dir = defaultExportDir();
    fs.mkdirSync(dir, { recursive: true });
    if (kind === "log") {
      const logDir = process.env.V14_LOG_DIR || path.resolve(__dirname, "..", "..", "data", "logs");
      const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[:.]/g, "-");
      const output = path.join(dir, `招聘智能体_logs_${stamp}.log`);
      const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((name) => name.startsWith("app.log")) : [];
      const chunks = [];
      for (const name of files) {
        chunks.push(`===== ${name} =====\n`, fs.readFileSync(path.join(logDir, name), "utf8"));
      }
      fs.writeFileSync(output, chunks.join("\n"), "utf8");
      finishTask(db, task.id, { progress: { kind, filePath: output, count: files.length } });
      return;
    }
    const result = exportRoleToExcel(db, task.payload.roleUuid, { outputDir: dir });
    finishTask(db, task.id, { progress: { kind, filePath: result.filePath, count: result.count } });
    return;
  }

  if (task.type === "report") {
    startTask(db, task.id, {});
    const roles = runningRoles(db);
    if (!roles.length) {
      finishTask(db, task.id, { progress: { reports: 0, reason: "没有运行中角色" } });
      return;
    }
    const reports = roles.map((role) => buildReport(db, { roleUuid: role.role_uuid, date: task.payload.dateKey }));
    finishTask(db, task.id, { progress: { reports: reports.length } });
    return;
  }

  if (task.type === "score") {
    startTask(db, task.id, {});
    const summary = await scoreAllRoles(db);
    finishTask(db, task.id, { progress: summary });
    return;
  }

  failTask(db, task.id, `未知任务类型：${task.type}`, { retry: false });
}

function startTaskWorker(db, options = {}) {
  let running = false;
  let current = null;
  let timer = null;
  const intervalMs = Math.max(500, Number(options.intervalMs || 2000));
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const task = pickTask(db);
      if (task) {
        if (task.status === "retrying" && task.next_retry_at && new Date(task.next_retry_at) > new Date()) {
          return;
        }
        current = task;
        await runTask(db, task);
      }
    } catch (error) {
      if (current) failTask(db, current.id, error.stack || error.message, { retry: false });
    } finally {
      current = null;
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { startTaskWorker, runTask, pickTask };
