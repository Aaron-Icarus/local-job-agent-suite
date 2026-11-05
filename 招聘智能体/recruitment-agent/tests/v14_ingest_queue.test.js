const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const { processRawQueue } = require("../src/v14/ingest_service");
const { countJobs, listJobs } = require("../src/v14/jobs_repo");
const { migrateV13Store } = require("../src/v14/migrate_v13");

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-ingest-"));
  const outputs = path.join(root, "outputs");
  fs.mkdirSync(outputs, { recursive: true });
  return { root, outputs };
}

function rawPayload(records, extra = {}) {
  return {
    platform: "BOSS",
    dateKey: "2026-11-11",
    stage: "raw",
    complete: true,
    records,
    ...extra,
  };
}

function job(overrides = {}) {
  const jd =
    "负责企业软件实施、需求调研、上线培训和项目交付，需要沟通能力和项目经验。" +
    "能够独立推进项目并协调客户。";
  const longJd = `${jd}${jd}`;
  return {
    platform: "BOSS",
    platform_job_id: "boss-1001",
    job_id: "boss-1001",
    company: "测试公司",
    job_title: "实施顾问",
    salary: "15-20K",
    city: "上海",
    district: "浦东新区",
    job_url: "https://example.com/job/1001",
    job_description: longJd,
    detail_status: "ok",
    collected_at: "2026-11-11T10:00:00+08:00",
    ...overrides,
  };
}

test("跨天文件都能登记和处理，采集日期不等于入库日期", (t) => {
  const { root, outputs } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = path.join(outputs, "boss_daily_20261111_jobs_100000.json");
  fs.writeFileSync(first, JSON.stringify(rawPayload([job()])), "utf8");

  const summary = processRawQueue(dbInfo.db, { outputsDir: outputs });
  assert.equal(summary.failed, 0);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.inserted, 1);

  const jobs = listJobs(dbInfo.db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].display_id, "A001");
  assert.equal(jobs[0].first_seen_date, "2026-11-11");
  assert.equal(jobs[0].last_seen_date, "2026-11-11");
  assert.ok(jobs[0].ingested_at);
  assert.notEqual(jobs[0].first_seen_date, jobs[0].ingested_at.slice(0, 10));
});

test("同一岗位再次采集：保留首次日期，更新最近日期，不重复编号", (t) => {
  const { root, outputs } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = path.join(outputs, "boss_daily_20261111_jobs_100000.json");
  const second = path.join(outputs, "boss_daily_20261112_jobs_100000.json");
  fs.writeFileSync(first, JSON.stringify(rawPayload([job()])), "utf8");
  fs.writeFileSync(
    second,
    JSON.stringify(
      rawPayload(
        [job({ collected_at: "2026-11-12T09:00:00+08:00", salary: "18-22K" })],
        { dateKey: "2026-11-12" }
      )
    ),
    "utf8"
  );

  processRawQueue(dbInfo.db, { outputsDir: outputs });
  processRawQueue(dbInfo.db, { outputsDir: outputs });

  const jobs = listJobs(dbInfo.db);
  assert.equal(countJobs(dbInfo.db), 1);
  assert.equal(jobs[0].display_id, "A001");
  assert.equal(jobs[0].first_seen_date, "2026-11-11");
  assert.equal(jobs[0].last_seen_date, "2026-11-12");
  assert.equal(jobs[0].salary_text, "18-22K");
  assert.ok(Number(jobs[0].long_lived_days) >= 0);
});

test("同一文件重复处理是幂等的", (t) => {
  const { root, outputs } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = path.join(outputs, "boss_daily_20261111_jobs_100000.json");
  fs.writeFileSync(file, JSON.stringify(rawPayload([job()])), "utf8");

  processRawQueue(dbInfo.db, { outputsDir: outputs });
  processRawQueue(dbInfo.db, { outputsDir: outputs });

  assert.equal(countJobs(dbInfo.db), 1);
  const raw = dbInfo.db.prepare("SELECT * FROM raw_files").all();
  assert.equal(raw.length, 1);
  assert.equal(raw[0].status, "done");
  assert.equal(raw[0].ingested_count, 1);
});

test("缺 JD 的记录进入待补，不占编号", (t) => {
  const { root, outputs } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = path.join(outputs, "boss_daily_20261111_jobs_100000.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      rawPayload([
        job(),
        job({ platform_job_id: "boss-1002", job_id: "boss-1002", job_description: "太短" }),
      ])
    ),
    "utf8"
  );

  const summary = processRawQueue(dbInfo.db, { outputsDir: outputs });
  assert.equal(summary.pending, 1);
  assert.equal(countJobs(dbInfo.db), 1);
  const pending = dbInfo.db.prepare("SELECT * FROM pending_jobs").all();
  assert.equal(pending.length, 1);
  assert.match(pending[0].reasons_json, /JD/);
  const raw = dbInfo.db.prepare("SELECT * FROM raw_files").get();
  assert.equal(raw.status, "done");
  assert.equal(raw.pending_count, 1);
});

test("非法 JSON 文件标记 failed，修复后可以重试", (t) => {
  const { root, outputs } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = path.join(outputs, "boss_daily_20261111_jobs_100000.json");
  fs.writeFileSync(file, "{not-json", "utf8");
  let summary = processRawQueue(dbInfo.db, { outputsDir: outputs });
  assert.equal(summary.failed, 1);
  let raw = dbInfo.db.prepare("SELECT * FROM raw_files").get();
  assert.equal(raw.status, "failed");
  assert.equal(raw.attempts, 1);

  fs.writeFileSync(file, JSON.stringify(rawPayload([job()])), "utf8");
  summary = processRawQueue(dbInfo.db, { outputsDir: outputs });
  assert.equal(summary.succeeded, 1);
  raw = dbInfo.db.prepare("SELECT * FROM raw_files").get();
  assert.equal(raw.status, "done");
  assert.equal(raw.attempts, 2);
  assert.equal(countJobs(dbInfo.db), 1);
});

test("猎聘使用独立编号前缀", (t) => {
  const { root, outputs } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = path.join(outputs, "liepin_daily_20261111_jobs_100000.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      rawPayload(
        [
          job({
            platform: "猎聘",
            platform_job_id: "liepin-2001",
            job_id: "liepin-2001",
            job_url: "https://example.com/liepin/2001",
          }),
        ],
        { platform: "猎聘" }
      )
    ),
    "utf8"
  );

  processRawQueue(dbInfo.db, { outputsDir: outputs });
  const jobs = listJobs(dbInfo.db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].display_id, "B001");
});

test("v1.3 job_store 迁移保留编号、采集时间和旧评分", (t) => {
  const { root } = tempProject();
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const oldStore = path.join(root, "job_store.json");
  fs.writeFileSync(
    oldStore,
    JSON.stringify({
      version: 1,
      jobs: {
        "boss:old-1": {
          job_store_key: "boss:old-1",
          platform: "BOSS",
          platform_job_id: "old-1",
          display_id: "A007",
          first_seen_at: "2026-11-11T10:00:00+08:00",
          last_seen_at: "2026-11-12T10:00:00+08:00",
          ingested_at: "2026-11-12T11:00:00+08:00",
          record_status: "duplicate",
          duplicate_score: 0.9,
          job_status: "open",
          score: { overall: 77, tier: "可关注" },
          facts: {
            platform_job_id: "old-1",
            company: "旧公司",
            job_title: "旧岗位",
            job_description: "旧岗位描述，长度足够用于迁移测试。".repeat(3),
            collected_at: "2026-11-11T10:00:00+08:00",
          },
        },
      },
    }),
    "utf8"
  );

  const result = migrateV13Store(dbInfo.db, oldStore);
  assert.equal(result.inserted, 1);
  const jobs = listJobs(dbInfo.db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].display_id, "A007");
  assert.equal(jobs[0].first_seen_date, "2026-11-11");
  assert.equal(jobs[0].last_seen_date, "2026-11-12");
  assert.equal(jobs[0].duplicate_status, "duplicate");
  assert.match(jobs[0].legacy_score_json, /77/);
});
