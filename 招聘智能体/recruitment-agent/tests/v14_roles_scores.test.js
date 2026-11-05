const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const { processRawQueue } = require("../src/v14/ingest_service");
const { countJobs, listJobs } = require("../src/v14/jobs_repo");
const roles = require("../src/v14/role_service");
const scores = require("../src/v14/scores_repo");
const { migrateV13Store } = require("../src/v14/migrate_v13");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-role-"));
  const outputs = path.join(root, "outputs");
  fs.mkdirSync(outputs, { recursive: true });
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, outputs, db: dbInfo.db };
}

function job(overrides = {}) {
  const jd = "负责企业软件实施、需求调研、上线培训和项目交付，需要沟通能力和项目经验。".repeat(2);
  return {
    platform: "BOSS",
    platform_job_id: "boss-1001",
    job_id: "boss-1001",
    company: "测试公司",
    job_title: "实施顾问",
    salary: "15-20K",
    city: "上海",
    job_url: "https://example.com/job/1001",
    job_description: jd,
    detail_status: "ok",
    collected_at: "2026-11-11T10:00:00+08:00",
    ...overrides,
  };
}

function writeRaw(outputs, name, records, platform = "BOSS") {
  const file = path.join(outputs, name);
  fs.writeFileSync(
    file,
    JSON.stringify({ platform, dateKey: "2026-11-11", complete: true, records }),
    "utf8"
  );
  return file;
}

function createRole(db, overrides = {}) {
  return roles.createRole(db, {
    nickname: "实施顾问",
    profile_md: "5 年企业软件实施经验，目标上海实施顾问。",
    target_roles: "实施顾问",
    target_city: "上海",
    target_salary: "15-25K",
    special_requirements: "不出差太多",
    role_channels: ["BOSS", "猎聘"],
    role_keywords: ["实施顾问", "交付专员"],
    ...overrides,
  }).role;
}

test("角色生命周期：待确认→待启动→首次启动锁定→暂停/复制", (t) => {
  const { db } = setup(t);
  let role = createRole(db);
  assert.equal(role.status, "pending_confirm");
  assert.equal(role.role_number, "R001");
  assert.equal(role.has_started, false);

  const updated = roles.updateRole(db, role.role_uuid, { nickname: "实施顾问A" });
  assert.equal(updated.role.status, "pending_confirm");
  assert.equal(updated.role.nickname, "实施顾问A");

  const confirmed = roles.confirmRole(db, role.role_uuid);
  assert.equal(confirmed.role.status, "pending_start");
  assert.ok(confirmed.role.confirmed_at);

  // 确认未启动仍可改，改后回待确认
  const editedAgain = roles.updateRole(db, role.role_uuid, { target_city: "杭州" });
  assert.equal(editedAgain.role.status, "pending_confirm");
  assert.equal(editedAgain.role.target_city, "杭州");

  roles.confirmRole(db, role.role_uuid);
  const started = roles.startRole(db, role.role_uuid);
  assert.equal(started.status, "running");
  assert.equal(started.has_started, true);
  assert.ok(started.first_started_at);

  assert.throws(() => roles.updateRole(db, role.role_uuid, { nickname: "不能改" }), /不可修改/);
  const paused = roles.pauseRole(db, role.role_uuid);
  assert.equal(paused.status, "paused");

  const copy = roles.copyRole(db, role.role_uuid, { nickname: "副本" });
  assert.equal(copy.status, "pending_confirm");
  assert.equal(copy.has_started, false);
  assert.notEqual(copy.role_uuid, role.role_uuid);
  assert.equal(roles.listRoles(db).length, 2);
});

test("最多 3 个活跃角色；软删除后可再建", (t) => {
  const { db } = setup(t);
  const a = createRole(db, { nickname: "A" });
  const b = createRole(db, { nickname: "B" });
  const c = createRole(db, { nickname: "C" });
  assert.throws(() => createRole(db, { nickname: "D" }), /最多只能有 3 个角色/);
  roles.softDeleteRole(db, a.role_uuid);
  assert.equal(roles.listRoles(db).length, 2);
  const d = createRole(db, { nickname: "D" });
  assert.equal(roles.listRoles(db).length, 3);
  assert.ok(d.role_number);
  assert.ok(b.role_uuid);
  assert.ok(c.role_uuid);
});

test("本地相似度会提示高重合，并允许强制确认", (t) => {
  const { db } = setup(t);
  const first = createRole(db, { nickname: "A", profile_md: "5年企业软件实施经验，目标上海实施顾问，擅长项目交付。" });
  const second = roles.createRole(db, {
    nickname: "B",
    profile_md: "5年企业软件实施经验，目标上海实施顾问，擅长项目交付。",
    target_roles: "实施顾问",
    target_city: "上海",
    target_salary: "15-25K",
    special_requirements: "不出差太多",
    role_channels: ["BOSS", "猎聘"],
    role_keywords: ["实施顾问", "交付专员"],
  });
  assert.ok(second.similar.length >= 1);
  assert.equal(second.similar[0].role_uuid, first.role_uuid);
  const confirmed = roles.confirmRole(db, second.role.role_uuid, { force: true });
  assert.equal(confirmed.role.status, "pending_start");
  assert.ok(confirmed.similar.length >= 1);
});

test("角色先建后入库会自动进入评分队列", (t) => {
  const { db, outputs } = setup(t);
  const role = createRole(db, { nickname: "先建角色" });
  writeRaw(outputs, "boss_daily_20261111_jobs_100000.json", [job()]);
  processRawQueue(db, { outputsDir: outputs });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 1);
  assert.equal(scores.selectJobsForScoring(db, role.role_uuid).length, 1);
});

test("岗位入库后角色评分队列、评分序号和 needs_score", (t) => {
  const { db, outputs } = setup(t);
  writeRaw(outputs, "boss_daily_20261111_jobs_100000.json", [
    job(),
    job({ platform_job_id: "boss-1002", job_id: "boss-1002", job_title: "交付专员" }),
  ]);
  processRawQueue(db, { outputsDir: outputs });
  assert.equal(countJobs(db), 2);

  const role = createRole(db, { nickname: "A" });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 2);
  const pending = scores.selectJobsForScoring(db, role.role_uuid, { limit: 100 });
  assert.equal(pending.length, 2);
  const firstJob = pending[0];
  const saved = scores.saveScore(db, role.role_uuid, firstJob.job_uuid, {
    score: 82,
    explanation: "匹配",
    reasons: ["城市匹配"],
    risks: [],
  });
  assert.equal(saved.score, 82);
  assert.equal(saved.score_id, 1);
  assert.equal(scores.countPendingScores(db, role.role_uuid), 1);

  const second = scores.saveScore(db, role.role_uuid, pending[1].job_uuid, { score: 70 });
  assert.equal(second.score_id, 2);
  assert.equal(scores.countPendingScores(db, role.role_uuid), 0);

  // 角色画像修改后，旧评分早于修改时间，需要重新评分
  roles.updateRole(db, role.role_uuid, { target_city: "杭州" });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 2);
});

test("岗位内容变化、关闭、重新开放会更新角色 needs_score/skip", (t) => {
  const { db, outputs } = setup(t);
  writeRaw(outputs, "boss_daily_20261111_jobs_100000.json", [job()]);
  processRawQueue(db, { outputsDir: outputs });
  const role = createRole(db, { nickname: "A" });
  const jobRow = listJobs(db)[0];
  scores.saveScore(db, role.role_uuid, jobRow.job_uuid, { score: 80 });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 0);

  // 内容变化
  writeRaw(outputs, "boss_daily_20261112_jobs_100000.json", [
    job({
      collected_at: "2026-11-12T10:00:00+08:00",
      salary: "18-22K",
    }),
  ]);
  processRawQueue(db, { outputsDir: outputs });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 1);
  scores.saveScore(db, role.role_uuid, jobRow.job_uuid, { score: 85 });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 0);

  // 关闭
  db.prepare("UPDATE jobs SET job_status = 'closed', status_updated_at = ? WHERE job_uuid = ?").run(
    "2026-11-13T10:00:00.000Z",
    jobRow.job_uuid
  );
  const closedJob = db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobRow.job_uuid);
  scores.syncJobToRoles(db, closedJob, { statusChanged: true });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 0);
  assert.equal(scores.selectJobsForScoring(db, role.role_uuid).length, 0);
  const closedRoleJob = scores.getRoleJob(db, role.role_uuid, jobRow.job_uuid);
  assert.equal(closedRoleJob.skip_reason, "closed");

  // 角色修改不能把已关闭岗位重新放回评分队列
  roles.updateRole(db, role.role_uuid, { target_city: "苏州" });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 0);

  // 重新开放
  db.prepare("UPDATE jobs SET job_status = 'open', status_updated_at = ? WHERE job_uuid = ?").run(
    "2026-11-14T10:00:00.000Z",
    jobRow.job_uuid
  );
  const openJob = db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobRow.job_uuid);
  scores.syncJobToRoles(db, openJob, { statusChanged: true, reopened: true });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 1);
  assert.equal(scores.getRoleJob(db, role.role_uuid, jobRow.job_uuid).skip_reason, "");

  // 重复
  db.prepare("UPDATE jobs SET duplicate_status = 'duplicate' WHERE job_uuid = ?").run(jobRow.job_uuid);
  const duplicateJob = db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobRow.job_uuid);
  scores.syncJobToRoles(db, duplicateJob, { duplicateChanged: true });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 0);
  assert.equal(scores.getRoleJob(db, role.role_uuid, jobRow.job_uuid).skip_reason, "duplicate");

  // 恢复唯一
  db.prepare("UPDATE jobs SET duplicate_status = 'unique' WHERE job_uuid = ?").run(jobRow.job_uuid);
  const uniqueJob = db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobRow.job_uuid);
  scores.syncJobToRoles(db, uniqueJob, { duplicateChanged: true });
  assert.equal(scores.countPendingScores(db, role.role_uuid), 1);
});

test("同一岗位对不同角色独立评分，迁移默认角色保留旧评分", (t) => {
  const { db, root, outputs } = setup(t);
  writeRaw(outputs, "boss_daily_20261111_jobs_100000.json", [job()]);
  processRawQueue(db, { outputsDir: outputs });
  const jobRow = listJobs(db)[0];
  const a = createRole(db, { nickname: "A" });
  const b = createRole(db, { nickname: "B" });
  scores.saveScore(db, a.role_uuid, jobRow.job_uuid, { score: 90 });
  scores.saveScore(db, b.role_uuid, jobRow.job_uuid, { score: 40 });
  assert.equal(scores.getRoleJob(db, a.role_uuid, jobRow.job_uuid).score, 90);
  assert.equal(scores.getRoleJob(db, b.role_uuid, jobRow.job_uuid).score, 40);

  const legacyStore = path.join(root, "job_store.json");
  fs.writeFileSync(
    legacyStore,
    JSON.stringify({
      jobs: {
        "boss:legacy-1": {
          platform: "BOSS",
          platform_job_id: "legacy-1",
          display_id: "A009",
          first_seen_at: "2026-11-11T10:00:00+08:00",
          ingested_at: "2026-11-12T10:00:00+08:00",
          job_status: "open",
          score: { overall: 66 },
          facts: {
            platform_job_id: "legacy-1",
            company: "旧公司",
            job_title: "旧岗位",
            job_description: "旧岗位描述，长度足够用于迁移测试。".repeat(3),
          },
        },
      },
    }),
    "utf8"
  );
  migrateV13Store(db, legacyStore);
  const defaultRole = roles.ensureDefaultRoleForMigration(db, { nickname: "默认" });
  const migrated = roles.migrateLegacyScores(db, defaultRole.role_uuid);
  assert.ok(migrated.migrated >= 1);
});
