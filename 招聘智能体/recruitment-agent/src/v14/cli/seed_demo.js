#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../db");
const { processRawQueue } = require("../ingest_service");
const { listJobs, countJobs } = require("../jobs_repo");
const roles = require("../role_service");
const scores = require("../scores_repo");
const { importResume } = require("../resumes_repo");
const { buildReport } = require("../report_service");

const DEMO_RESUME = `# 示例候选人 简历

## 目标岗位
实施顾问、交付专员

## 技能
项目管理、客户沟通、需求调研、SQL、企业软件实施

## 工作经历
5 年企业软件实施与项目交付经验，负责需求调研、上线培训和客户验收。

## 教育
本科
`;

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function seed(db, options = {}) {
  if (countJobs(db) > 0 || roles.listRoles(db).length > 0) {
    return { seeded: false, reason: "database already has data", jobs: countJobs(db), roles: roles.listRoles(db).length };
  }
  const outputs = options.outputsDir || path.join(os.tmpdir(), "job-agent-v14-demo-outputs");
  fs.rmSync(outputs, { recursive: true, force: true });
  fs.mkdirSync(outputs, { recursive: true });
  const jd = "负责企业软件实施、需求调研、上线培训、客户验收和项目交付，需要沟通能力、项目推进能力和客户服务意识。".repeat(2);
  const records = [
    ["demo-1001", "云栈科技", "实施顾问", "18-25K", "浦东新区", "2026-11-03"],
    ["demo-1002", "智问应用", "交付专员", "15-20K", "徐汇区", "2026-11-04"],
    ["demo-1003", "远景数据", "实施顾问", "20-28K", "静安区", "2026-11-05"],
    ["demo-1004", "北辰软件", "客户成功经理", "16-22K", "长宁区", "2026-11-05"],
    ["demo-1005", "星云信息", "项目交付顾问", "19-26K", "黄浦区", "2026-11-06"],
    ["demo-1006", "长河科技", "实施项目经理", "22-30K", "浦东新区", "2026-11-06"],
  ].map(([id, company, title, salary, district, date]) => ({
    platform: "BOSS",
    platform_job_id: id,
    job_id: id,
    company,
    job_title: title,
    salary,
    city: "上海",
    district,
    job_url: `https://example.com/job/${id}`,
    job_description: jd,
    detail_status: "ok",
    collected_at: `${date}T10:00:00+08:00`,
  }));
  const rawPath = path.join(outputs, "boss_daily_20261106_jobs_demo.json");
  fs.writeFileSync(rawPath, JSON.stringify({ platform: "BOSS", dateKey: "2026-11-06", records }), "utf8");
  processRawQueue(db, { outputsDir: outputs });

  const resume = importResume(db, { name: "示例候选人", content: DEMO_RESUME, fileName: "demo_resume.md" });
  const created = roles.createRole(db, {
    nickname: "实施顾问-A",
    resume_id: resume.id,
    target_roles: "实施顾问, 交付专员",
    target_city: "上海",
    target_salary: "15-28K",
    role_keywords: ["实施顾问", "交付专员", "客户成功", "项目交付"],
    role_channels: ["BOSS", "猎聘"],
  });
  roles.confirmRole(db, created.role.role_uuid, { channels: ["BOSS", "猎聘"] });
  roles.startRole(db, created.role.role_uuid);
  for (const job of listJobs(db)) {
    const high = /实施|交付|项目/.test(job.title);
    scores.saveScore(db, created.role.role_uuid, job.job_uuid, {
      score: high ? 82 + (job.display_id.charCodeAt(3) % 5) : 68,
      tier: high ? "重点关注" : "可关注",
      explanation: high ? "岗位方向、城市和薪资与画像匹配" : "城市匹配，岗位方向需要进一步确认",
      risks: high ? [] : ["岗位职责偏客户成功，需确认是否接受"],
      note: "演示数据",
    });
  }
  buildReport(db, { roleUuid: created.role.role_uuid, date: "2026-11-06" });
  return {
    seeded: true,
    jobs: countJobs(db),
    roles: roles.listRoles(db).length,
    roleUuid: created.role.role_uuid,
    resumeId: resume.id,
  };
}

function main() {
  const dbPath = argValue("db", process.env.V14_DB_PATH || "");
  const { db, path: resolved } = openDatabase(dbPath);
  try {
    const result = seed(db);
    console.log(JSON.stringify({ ok: true, db: resolved, ...result }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { DEMO_RESUME, seed };
