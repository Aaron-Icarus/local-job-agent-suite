const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const { evaluateSchedule } = require("../src/v14/scheduler");
const { getSettings, saveSettings, DEFAULT_SETTINGS } = require("../src/v14/settings_repo");
const roles = require("../src/v14/role_service");
const { planTick, createCollectionPlan } = require("../src/v14/task_service");
const tasks = require("../src/v14/tasks_repo");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-sched-"));
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dbInfo.db;
}

function runningRole(db) {
  const created = roles.createRole(db, {
    nickname: "调度角色",
    profile_md: "实施顾问",
    target_roles: "实施顾问",
    role_keywords: ["实施顾问", "交付专员"],
    role_channels: ["BOSS", "猎聘"],
  });
  roles.confirmRole(db, created.role.role_uuid);
  return roles.startRole(db, created.role.role_uuid);
}

test("默认设置与 1 小时间隔校验", () => {
  assert.equal(DEFAULT_SETTINGS.min_interval_hours, 3);
  const validated = require("../src/v14/settings_repo").validateSettings({
    min_interval_hours: 0.5,
    max_per_hour: 3,
  });
  assert.equal(validated.settings.min_interval_hours, 1);
  assert.equal(validated.settings.max_per_hour, 1);
  assert.ok(validated.warnings.length >= 2);
});

test("调度：空闲窗口、12:30 强制、1 小时硬间隔、R-2h、R-1h、日报", () => {
  const settings = { ...DEFAULT_SETTINGS };
  const base = "2026-11-05";
  const at = (hhmm) => new Date(`${base}T${hhmm}:00+08:00`);

  let result = evaluateSchedule({
    now: at("09:10"),
    settings,
    state: { executedCount: 0, idleAllowed: false },
  });
  assert.equal(result.shouldCollect, false);
  assert.equal(result.reason, "not_idle");

  result = evaluateSchedule({
    now: at("12:31"),
    settings,
    state: { executedCount: 0, idleAllowed: false },
  });
  assert.equal(result.shouldCollect, true);
  assert.equal(result.forceReason, "checkpoint_1230");

  result = evaluateSchedule({
    now: at("19:00"),
    settings,
    state: { executedCount: 0, idleAllowed: false },
  });
  assert.equal(result.shouldCollect, true);
  assert.match(result.forceReason, /pre_report/);

  result = evaluateSchedule({
    now: at("19:00"),
    settings: { ...settings, collect_at_ingest: true },
    state: { executedCount: 1, lastRunAt: at("18:30").toISOString(), idleAllowed: false },
  });
  assert.equal(result.shouldCollect, false);
  assert.equal(result.blockedByInterval, true);

  result = evaluateSchedule({
    now: at("20:00"),
    settings,
    state: { executedCount: 1, idleAllowed: false, pendingScores: 3 },
  });
  assert.equal(result.shouldCollect, false);
  assert.equal(result.reportPrepWindow, true);
  assert.equal(result.shouldScore, true);

  result = evaluateSchedule({
    now: at("21:00"),
    settings,
    state: { executedCount: 1, reportSent: false },
  });
  assert.equal(result.reportDue, true);
});

test("任务状态机：开始、暂停、恢复、完成", (t) => {
  const db = setup(t);
  const task = tasks.createTask(db, { type: "collect", priority: tasks.PRIORITY.COLLECT, payload: { x: 1 } });
  const started = tasks.startTask(db, task.id, { stage: "start" });
  assert.equal(started.status, "running");
  assert.equal(started.attempts, 1);
  const paused = tasks.pauseTask(db, task.id);
  assert.equal(paused.status, "paused");
  const resumed = tasks.resumeTask(db, task.id);
  assert.equal(resumed.status, "queued");
  tasks.startTask(db, task.id);
  const done = tasks.finishTask(db, task.id, { progress: { stage: "done" } });
  assert.equal(done.status, "succeeded");
});

test("计划采集：运行中角色 × 2 平台生成事件和子任务", (t) => {
  const db = setup(t);
  const role = runningRole(db);
  const result = createCollectionPlan(db, {
    now: new Date("2026-11-05T12:31:00+08:00"),
    forceReason: "checkpoint_1230",
  });
  assert.ok(result);
  assert.equal(result.event.subtasks.length, 2);
  assert.equal(result.event.status, "queued");
  assert.equal(result.task.type, "collect");
  assert.equal(result.event.subtasks[0].role_uuid, role.role_uuid);
  assert.ok(result.event.subtasks.every((item) => item.status === "queued"));
});

test("planTick 在没有运行中角色时不创建采集任务", (t) => {
  const db = setup(t);
  const result = planTick(db, {
    now: new Date("2026-11-05T12:31:00+08:00"),
    idleAllowed: false,
  });
  assert.equal(result.actions.filter((item) => item.type === "collect").length, 0);
});

test("planTick 生成采集任务，重复调用不会重复建运行中事件", (t) => {
  const db = setup(t);
  runningRole(db);
  const first = planTick(db, {
    now: new Date("2026-11-05T12:31:00+08:00"),
    idleAllowed: false,
  });
  assert.equal(first.actions.filter((item) => item.type === "collect").length, 1);
  const second = planTick(db, {
    now: new Date("2026-11-05T12:32:00+08:00"),
    idleAllowed: false,
  });
  assert.equal(second.actions.filter((item) => item.type === "collect").length, 0);
});
