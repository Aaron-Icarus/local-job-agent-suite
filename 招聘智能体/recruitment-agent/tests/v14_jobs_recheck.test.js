const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const recheck = require("../src/v14/job_recheck");

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

test("历史岗位确认：从远到近、关闭、记录总刷时间并防重复", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-recheck-"));
  const info = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    info.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const insert = info.db.prepare(
    `INSERT INTO jobs(job_uuid, display_id, platform, platform_job_id, job_url, company, title,
      city, last_seen_at, last_seen_date, job_status, first_seen_date, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run("old-1", "A101", "BOSS", "p1", "https://example.com/old", "旧公司", "旧岗位", "上海", `${daysAgo(10)}T00:00:00Z`, daysAgo(10), "open", daysAgo(20), new Date().toISOString(), new Date().toISOString());
  insert.run("recent-1", "A102", "BOSS", "p2", "https://example.com/new", "新公司", "新岗位", "上海", `${daysAgo(2)}T00:00:00Z`, daysAgo(2), "open", daysAgo(5), new Date().toISOString(), new Date().toISOString());

  const first = await recheck.runRecheck(info.db, { checker: async () => ({ status: "missing", evidence: "test" }) });
  assert.equal(first.batch.checked, 1);
  assert.equal(first.batch.closed, 1);
  assert.equal(first.details[0].displayId, "A101");
  const oldJob = info.db.prepare("SELECT * FROM jobs WHERE display_id = 'A101'").get();
  assert.equal(oldJob.job_status, "closed");
  assert.ok(oldJob.last_recheck_at);
  const recent = info.db.prepare("SELECT * FROM jobs WHERE display_id = 'A102'").get();
  assert.equal(recent.job_status, "open");
  assert.equal(recent.last_recheck_at, null);

  const second = await recheck.runRecheck(info.db, { checker: async () => ({ status: "missing" }) });
  assert.equal(second.batch.checked, 0);
  assert.equal(recheck.listBatches(info.db).length, 2);
});

test("历史岗位确认：异步进度、其他任务阻塞、可中断", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-recheck-async-"));
  const info = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    info.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const insert = info.db.prepare(
    `INSERT INTO jobs(job_uuid, display_id, platform, platform_job_id, job_url, company, title,
      city, last_seen_at, last_seen_date, job_status, first_seen_date, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let index = 0; index < 3; index += 1) {
    insert.run(`job-${index}`, `A20${index}`, "BOSS", `p${index}`, "https://example.com/job",
      "公司", "岗位", "上海", `${daysAgo(10)}T00:00:00Z`, daysAgo(10), "open", daysAgo(20),
      new Date().toISOString(), new Date().toISOString());
  }
  info.db.prepare(
    "INSERT INTO tasks(type, priority, status, payload_json, created_at, updated_at) VALUES('collect', 1, 'running', '{}', ?, ?)"
  ).run(new Date().toISOString(), new Date().toISOString());
  assert.equal(recheck.startRecheck(info.db).reason, "other_task");
  info.db.prepare("UPDATE tasks SET status = 'done'").run();

  const started = recheck.startRecheck(info.db, {
    checker: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { status: "unknown" };
    },
  });
  assert.equal(started.started, true);
  assert.equal(recheck.getStatus().total, 3);
  await new Promise((resolve) => setTimeout(resolve, 40));
  recheck.cancelRecheck();
  for (let index = 0; index < 30; index += 1) {
    if (!recheck.getStatus().running) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = recheck.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.canceled, true);
  assert.equal(recheck.listBatches(info.db)[0].status, "canceled");
});

