const { listTasks, startTask, finishTask, failTask } = require("./tasks_repo");
const { runCollectionEvent } = require("./collection_runner");
const { processRawQueue } = require("./ingest_service");
const { buildReport } = require("./report_service");
const { runningRoles } = require("./task_service");

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
    startTask(db, task.id, { eventId: task.payload.eventId });
    await runCollectionEvent(db, task.payload.eventId, { taskId: task.id });
    return;
  }

  if (task.type === "ingest") {
    startTask(db, task.id, {});
    const summary = processRawQueue(db, { discover: true });
    finishTask(db, task.id, { progress: summary });
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
    failTask(db, task.id, "评分执行器尚未接入，请先使用角色评分接口", { retry: false });
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
