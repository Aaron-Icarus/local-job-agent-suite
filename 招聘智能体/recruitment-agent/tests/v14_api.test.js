const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const { startServer } = require("../src/v14/app_server");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-api-"));
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dbInfo.db;
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test("API 健康检查、静态页面、设置校验和角色生命周期", async (t) => {
  const db = setup(t);
  const server = await startServer(db, { port: 0 });
  t.after(async () => server.close());
  const base = server.url;

  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /招聘智能体/);

  const health = await jsonFetch(`${base}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const settings = await jsonFetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ min_interval_hours: 0.5 }),
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.settings.min_interval_hours, 1);
  assert.ok(settings.body.warnings.length >= 1);

  const created = await jsonFetch(`${base}/api/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nickname: "API角色",
      profile_md: "实施顾问",
      role_keywords: ["实施顾问"],
      role_channels: ["BOSS"],
    }),
  });
  assert.equal(created.response.status, 200);
  const roleUuid = created.body.role.role_uuid;
  assert.ok(roleUuid);

  const confirmed = await jsonFetch(`${base}/api/roles/${roleUuid}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channels: ["BOSS"] }),
  });
  assert.equal(confirmed.body.role.status, "pending_start");

  const started = await jsonFetch(`${base}/api/roles/${roleUuid}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(started.body.role.status, "running");

  const roles = await jsonFetch(`${base}/api/roles`);
  assert.equal(roles.body.roles.length, 1);

  const board = await jsonFetch(`${base}/api/tasks/board`);
  assert.equal(board.body.ok, true);
  assert.ok(Array.isArray(board.body.tasks));

  const messages = await jsonFetch(`${base}/api/messages`);
  assert.equal(messages.body.ok, true);
  assert.equal(messages.body.original_message_platform.integrated, true);
  const testMessage = await jsonFetch(`${base}/api/messages/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(testMessage.response.status, 400);

  const exported = await fetch(`${base}/api/export/${roleUuid}`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type") || "", /ms-excel/);
  assert.match(await exported.text(), /API角色/);
});
