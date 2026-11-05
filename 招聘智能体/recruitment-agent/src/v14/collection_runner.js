const path = require("path");
const { spawn } = require("child_process");
const {
  getCollectionEvent,
  startCollectionEvent,
  startSubtask,
  finishSubtask,
  finishCollectionEvent,
} = require("./tasks_repo");

function collectorScript(platform) {
  return /liepin|猎聘/i.test(platform)
    ? path.join(__dirname, "..", "platforms", "liepin", "liepin_batch_collect.js")
    : path.join(__dirname, "..", "platforms", "boss", "boss_batch_collect.js");
}

function defaultRunSubtask(context) {
  return new Promise((resolve) => {
    const script = collectorScript(context.platform);
    const child = spawn(process.execPath, [script], {
      cwd: path.join(__dirname, "..", ".."),
      env: {
        ...process.env,
        V14_EVENT_ID: String(context.eventId),
        V14_SUBTASK_ID: String(context.subtaskId),
        V14_ROLE_UUID: context.roleUuid,
        V14_PLATFORM: context.platform,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: "failed", stopReason: "collector_timeout", stdout, stderr });
    }, Number(process.env.V14_COLLECT_TIMEOUT_MS || 45 * 60 * 1000));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "failed", stopReason: error.message, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: code === 0 ? "success" : "failed",
        stopReason: code === 0 ? "" : `collector_exit_${code}`,
        stdout,
        stderr,
      });
    });
  });
}

async function runCollectionEvent(db, eventId, options = {}) {
  const runner = options.runSubtask || defaultRunSubtask;
  const event = getCollectionEvent(db, eventId);
  if (!event) throw new Error("采集事件不存在");
  startCollectionEvent(db, eventId, event.force_reason);
  const results = [];
  for (const subtask of event.subtasks) {
    const keywordRows = db.prepare("SELECT * FROM keyword_tasks WHERE subtask_id = ? ORDER BY priority ASC, id ASC").all(subtask.id);
    startSubtask(db, subtask.id);
    let result;
    try {
      result = await runner({
        db,
        eventId,
        subtaskId: subtask.id,
        platform: subtask.platform,
        roleUuid: subtask.role_uuid,
        keywords: keywordRows.map((row) => row.keyword),
      });
    } catch (error) {
      result = { status: "failed", stopReason: error.message };
    }
    finishSubtask(db, subtask.id, {
      status: result.status || "success",
      stopReason: result.stopReason || "",
      keywordStats: result.keywordStats || [],
    });
    results.push({ subtaskId: subtask.id, ...result });
  }
  const finished = finishCollectionEvent(db, eventId);
  if (options.taskId) {
    const { finishTask, failTask } = require("./tasks_repo");
    if (finished.status === "failed") {
      failTask(db, options.taskId, "collection_failed", { retry: false });
    } else {
      finishTask(db, options.taskId, {
        progress: {
          eventId,
          status: finished.status,
          successSubtasks: finished.success_subtasks,
          failedSubtasks: finished.failed_subtasks,
        },
      });
    }
  }
  return { event: finished, results };
}

module.exports = { collectorScript, defaultRunSubtask, runCollectionEvent };
