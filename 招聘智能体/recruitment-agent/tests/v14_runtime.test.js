const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const roles = require("../src/v14/role_service");
const { createCollectionPlan } = require("../src/v14/task_service");
const { runCollectionEvent } = require("../src/v14/collection_runner");
const { buildChromeArgs } = require("../src/v14/chrome_manager");
const { runLoginChecks, lastCheck, shouldCheck } = require("../src/v14/login_monitor");
const { createNotification, sendNotification } = require("../src/v14/notifier");
const { canRetrySubtask, stuckLevel } = require("../src/v14/retry_policy");
const tasks = require("../src/v14/tasks_repo");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-runtime-"));
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dbInfo.db;
}

function startRole(db) {
  const created = roles.createRole(db, {
    nickname: "运行角色",
    profile_md: "实施顾问",
    target_roles: "实施顾问",
    role_keywords: ["实施顾问"],
    role_channels: ["BOSS", "猎聘"],
  });
  roles.confirmRole(db, created.role.role_uuid);
  return roles.startRole(db, created.role.role_uuid);
}

test("采集事件按子任务执行并回写任务状态", async (t) => {
  const db = setup(t);
  startRole(db);
  const plan = createCollectionPlan(db, {
    now: new Date("2026-11-05T12:31:00+08:00"),
    forceReason: "checkpoint_1230",
  });
  const result = await runCollectionEvent(db, plan.event.id, {
    taskId: plan.task.id,
    runSubtask: async (context) => {
      assert.ok(context.keywords.length >= 1);
      return {
        status: "success",
        keywordStats: [{ keyword: context.keywords[0], seen: 2, new: 1 }],
      };
    },
  });
  assert.equal(result.event.status, "success");
  assert.equal(result.event.success_subtasks, 2);
  const task = tasks.getTask(db, plan.task.id);
  assert.equal(task.status, "succeeded");
});

test("采集子任务失败会标记事件失败", async (t) => {
  const db = setup(t);
  startRole(db);
  const plan = createCollectionPlan(db, {
    now: new Date("2026-11-05T12:31:00+08:00"),
    forceReason: "checkpoint_1230",
  });
  const result = await runCollectionEvent(db, plan.event.id, {
    taskId: plan.task.id,
    runSubtask: async () => ({ status: "failed", stopReason: "risk" }),
  });
  assert.equal(result.event.status, "failed");
  assert.equal(tasks.getTask(db, plan.task.id).status, "failed");
});

test("Chrome 参数包含独立 Profile、CDP 端口、最小化", () => {
  const args = buildChromeArgs({ profileDir: "C:\\temp\\profile", port: 9333, startUrl: "https://www.zhipin.com" });
  assert.ok(args.includes("--remote-debugging-port=9333"));
  assert.ok(args.some((item) => item.startsWith("--user-data-dir=")));
  assert.ok(args.includes("--start-minimized"));
  assert.ok(args.includes("https://www.zhipin.com"));
});

test("登录检查 12 小时节流，成功后记录", async (t) => {
  const db = setup(t);
  const now = "2026-11-05T09:00:00+08:00";
  const first = await runLoginChecks(db, {
    now,
    check: async () => ({ ok: true }),
  });
  assert.equal(first.length, 2);
  assert.equal(first[0].status, "logged_in");
  assert.ok(lastCheck(db, "BOSS"));

  const second = await runLoginChecks(db, {
    now: "2026-11-05T18:00:00+08:00",
    check: async () => ({ ok: false }),
  });
  assert.ok(second.every((item) => item.skipped));
  assert.equal(shouldCheck("BOSS", { last: lastCheck(db, "BOSS"), now: "2026-11-06T10:00:00+08:00" }), true);
});

test("通知写入、发送、记录失败", async (t) => {
  const db = setup(t);
  const item = createNotification(db, { type: "risk", title: "风控", body: "需要人工处理" });
  const result = await sendNotification(db, item.id, {
    toast: () => true,
    tray: () => true,
    feishu: () => false,
  });
  assert.equal(result.ok, false);
  const saved = db.prepare("SELECT * FROM notifications WHERE id = ?").get(item.id);
  assert.equal(saved.status, "failed");
});

test("子任务重试上限与卡住等级", () => {
  assert.equal(canRetrySubtask({ attempts: 2, windowAttempts: 2 }).allowed, true);
  assert.equal(canRetrySubtask({ attempts: 3, windowAttempts: 3 }).allowed, false);
  assert.equal(stuckLevel({ lastHeartbeatAt: "2026-11-05T09:00:00+08:00", now: "2026-11-05T09:00:30+08:00" }).level, "ok");
  assert.equal(stuckLevel({ lastHeartbeatAt: "2026-11-05T09:00:00+08:00", now: "2026-11-05T09:01:30+08:00" }).level, "subtask_retry");
  assert.equal(stuckLevel({ lastHeartbeatAt: "2026-11-05T09:00:00+08:00", now: "2026-11-05T09:06:00+08:00" }).level, "global_stuck");
});
