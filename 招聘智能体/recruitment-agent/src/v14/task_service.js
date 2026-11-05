const { getSettings } = require("./settings_repo");
const { evaluateSchedule } = require("./scheduler");
const { listRoles } = require("./roles_repo");
const {
  PRIORITY,
  createTask,
  listTasks,
  createCollectionEvent,
  listCollectionEvents,
  countTodayExecuted,
  lastExecutedAt,
} = require("./tasks_repo");
const { shanghaiDateKey } = require("../core/time_utils");

const PLATFORMS = ["BOSS", "猎聘"];

function runningRoles(db) {
  return listRoles(db).filter((role) => role.status === "running");
}

function hasRunningCollection(db) {
  const rows = db.prepare(
    "SELECT id FROM collection_events WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1"
  ).get();
  return Boolean(rows);
}

function collectKeywords(role) {
  const keywords = Array.isArray(role.role_keywords) ? role.role_keywords : [];
  return keywords
    .map((item) => (typeof item === "string" ? { keyword: item, priority: 50 } : item))
    .filter((item) => item && item.keyword)
    .slice(0, 6);
}

function createCollectionPlan(db, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const roles = runningRoles(db);
  if (!roles.length) return null;
  const platforms = options.platforms || PLATFORMS;
  const subtasks = [];
  for (const role of roles) {
    for (const platform of platforms) {
      const channels = Array.isArray(role.role_channels) ? role.role_channels : [];
      if (channels.length && !channels.some((channel) => String(channel).toLowerCase() === platform.toLowerCase())) {
        continue;
      }
      subtasks.push({
        platform,
        roleUuid: role.role_uuid,
        keywords: collectKeywords(role),
      });
    }
  }
  if (!subtasks.length) return null;
  const event = createCollectionEvent(db, {
    eventDate: shanghaiDateKey(now),
    forceReason: options.forceReason || "",
    subtasks,
  });
  const task = createTask(db, {
    type: "collect",
    priority: PRIORITY.COLLECT,
    payload: {
      eventId: event.id,
      dateKey: shanghaiDateKey(now),
      forceReason: options.forceReason || "",
      subtaskCount: event.subtasks.length,
    },
  });
  return { event, task };
}

function planTick(db, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const settings = getSettings(db);
  const dateKey = shanghaiDateKey(now);
  const pendingRaw = Number(
    db.prepare("SELECT COUNT(*) AS count FROM raw_files WHERE status IN ('pending','failed')").get().count || 0
  );
  const pendingScores = Number(
    db.prepare("SELECT COUNT(*) AS count FROM role_jobs WHERE needs_score = 1").get().count || 0
  );
  const decision = evaluateSchedule({
    now,
    settings,
    state: {
      executedCount: countTodayExecuted(db, dateKey),
      lastRunAt: lastExecutedAt(db, dateKey),
      pendingRaw,
      pendingScores,
      reportSent: Boolean(options.reportSent),
      idleAllowed: Boolean(options.idleAllowed),
    },
  });

  const actions = [];
  if (decision.shouldCollect && !hasRunningCollection(db)) {
    const plan = createCollectionPlan(db, {
      now,
      forceReason: decision.forceReason,
      platforms: options.platforms,
    });
    if (plan) actions.push({ type: "collect", eventId: plan.event.id, taskId: plan.task.id });
  }
  if (decision.shouldIngest && !listTasks(db, { type: "ingest", status: "running", limit: 1 }).length) {
    const task = createTask(db, { type: "ingest", priority: PRIORITY.INGEST, payload: { dateKey } });
    actions.push({ type: "ingest", taskId: task.id });
  }
  if (
    decision.shouldScore &&
    !listTasks(db, { type: "score", status: "running", limit: 1 }).length
  ) {
    const task = createTask(db, { type: "score", priority: PRIORITY.SCORE, payload: { dateKey } });
    actions.push({ type: "score", taskId: task.id });
  }
  if (decision.reportDue && !listTasks(db, { type: "report", status: "running", limit: 1 }).length) {
    const task = createTask(db, { type: "report", priority: PRIORITY.REPORT, payload: { dateKey } });
    actions.push({ type: "report", taskId: task.id });
  }
  return { decision, actions, settings };
}

function getTaskBoard(db) {
  return {
    tasks: listTasks(db, { limit: 50 }),
    collectionEvents: listCollectionEvents(db, { limit: 20 }),
    runningCollection: hasRunningCollection(db),
  };
}

module.exports = {
  PLATFORMS,
  runningRoles,
  hasRunningCollection,
  createCollectionPlan,
  planTick,
  getTaskBoard,
};
