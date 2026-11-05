const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const { processRawQueue } = require("../src/v14/ingest_service");
const { listJobs } = require("../src/v14/jobs_repo");
const roles = require("../src/v14/role_service");
const scores = require("../src/v14/scores_repo");
const ai = require("../src/v14/ai_providers");
const { encryptSecret, decryptSecret } = require("../src/v14/secret_store");
const reports = require("../src/v14/report_service");
const { exportRoleToExcel, buildExcelHtml } = require("../src/v14/export_service");
const { parseResumeMarkdown } = require("../src/v14/resume_parser");
const resumes = require("../src/v14/resumes_repo");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-service-"));
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
  return {
    platform: "BOSS",
    platform_job_id: "boss-1001",
    job_id: "boss-1001",
    company: "测试公司",
    job_title: "实施顾问",
    salary: "15-20K",
    city: "上海",
    job_url: "https://example.com/job/1001",
    job_description: "负责企业软件实施、需求调研、上线培训和项目交付，需要沟通能力和项目经验。".repeat(2),
    detail_status: "ok",
    collected_at: "2026-11-11T10:00:00+08:00",
    ...overrides,
  };
}

function seedJobAndRole(t) {
  const env = setup(t);
  const file = path.join(env.outputs, "boss_daily_20261111_jobs_100000.json");
  fs.writeFileSync(file, JSON.stringify({ platform: "BOSS", dateKey: "2026-11-11", records: [job()] }), "utf8");
  processRawQueue(env.db, { outputsDir: env.outputs });
  const created = roles.createRole(env.db, {
    nickname: "A",
    profile_md: "实施顾问",
    role_keywords: ["实施顾问"],
    role_channels: ["BOSS"],
  });
  roles.confirmRole(env.db, created.role.role_uuid);
  roles.startRole(env.db, created.role.role_uuid);
  const jobRow = listJobs(env.db)[0];
  scores.saveScore(env.db, created.role.role_uuid, jobRow.job_uuid, {
    score: 88,
    tier: "重点关注",
    explanation: "匹配",
    risks: ["通勤"],
    note: "备注",
  });
  return { ...env, role: created.role, job: jobRow };
}

test("AI Key 加密存储、供应商排序和逐级降级", async (t) => {
  const { db } = setup(t);
  const cipher = encryptSecret("sk-test-123");
  assert.notEqual(cipher, "sk-test-123");
  assert.equal(decryptSecret(cipher), "sk-test-123");

  const first = ai.saveProvider(db, {
    name: "坏供应商",
    type: "openai",
    base_url: "https://bad.example",
    model: "x",
    api_key: "bad",
    sort_order: 1,
  });
  const second = ai.saveProvider(db, {
    name: "好供应商",
    type: "openai",
    base_url: "https://good.example",
    model: "x",
    api_key: "good",
    sort_order: 2,
  });
  assert.equal(first.has_key, true);
  assert.equal(ai.listProviders(db).length, 2);

  const result = await ai.runWithFallback(db, async (provider) => {
    if (provider.name === "坏供应商") throw new Error("down");
    return { text: "ok" };
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider.name, "好供应商");
  assert.equal(result.errors.length, 1);
  assert.equal(ai.deleteProvider(db, second.id), 1);
});

test("日报构建、发送和 2 周清理", async (t) => {
  const { db, role } = seedJobAndRole(t);
  const report = reports.buildReport(db, { roleUuid: role.role_uuid, date: "2026-11-12" });
  assert.match(report.content, /重点关注/);
  assert.match(report.content, /测试公司/);
  const sent = await reports.sendReport(db, report.id, {
    sender: async () => ({ ok: true }),
  });
  assert.equal(sent.ok, true);
  assert.equal(reports.listReports(db, { roleUuid: role.role_uuid }).length, 1);

  db.prepare("UPDATE reports SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", report.id);
  assert.equal(reports.cleanupReports(db, 14), 1);
});

test("Excel 导出包含岗位、评分和可点击链接", (t) => {
  const { db, role, root } = seedJobAndRole(t);
  const html = buildExcelHtml(db, role.role_uuid);
  assert.match(html, /测试公司/);
  assert.match(html, /重点关注/);
  assert.match(html, /<a href="https:\/\/example.com\/job\/1001">/);
  const result = exportRoleToExcel(db, role.role_uuid, { outputDir: path.join(root, "downloads") });
  assert.ok(fs.existsSync(result.filePath));
  assert.equal(result.count, 1);
  assert.match(fs.readFileSync(result.filePath, "utf8"), /测试公司/);
});

test("MD 简历解析、导入并生成角色画像", (t) => {
  const { db } = setup(t);
  const markdown = `# 张三简历
## 目标岗位
实施顾问、交付专员
## 技能
项目管理、客户沟通、SQL
## 工作经历
5 年企业软件实施与项目交付经验。
## 教育
本科
`;
  const parsed = parseResumeMarkdown(markdown);
  assert.equal(parsed.name, "张三");
  assert.ok(parsed.target_roles.includes("实施顾问"));
  assert.ok(parsed.skills.includes("项目管理"));

  const resume = resumes.importResume(db, { name: "张三", content: markdown, fileName: "zhangsan.md" });
  assert.ok(resume.id);
  assert.match(resume.parsed.raw_md, /张三/);
  const created = roles.createRole(db, {
    nickname: "张三角色",
    resume_id: resume.id,
    target_roles: "实施顾问",
  });
  assert.equal(created.role.resume_id, resume.id);
  assert.match(created.role.profile_md, /实施顾问/);
  assert.deepEqual(created.role.role_channels, []);
});
