const { nowIso } = require("./jobs_repo");
const { getRole } = require("./roles_repo");

function reportRows(db, roleUuid, limit = 20) {
  return db.prepare(
    `SELECT rj.*, j.company, j.title, j.salary_text, j.city, j.job_url, j.first_seen_date, j.last_seen_date,
            j.job_status, j.duplicate_status
     FROM role_jobs rj
     JOIN jobs j ON j.job_uuid = rj.job_uuid
     WHERE rj.role_uuid = ? AND rj.score IS NOT NULL
       AND j.job_status <> 'closed' AND j.duplicate_status <> 'duplicate'
     ORDER BY rj.score DESC, rj.score_time DESC
     LIMIT ?`
  ).all(roleUuid, limit);
}

function buildReport(db, input = {}) {
  const role = getRole(db, input.roleUuid);
  if (!role) throw new Error("角色不存在");
  const date = input.date || new Date().toISOString().slice(0, 10);
  const rows = reportRows(db, role.role_uuid, Number(input.limit || 20));
  const lines = [
    `# ${date} ${role.role_number} ${role.nickname} 日报`,
    "",
    `共 ${rows.length} 个已评分岗位`,
    "",
  ];
  for (const row of rows) {
    lines.push(
      `## ${row.job_display_id} ${row.company || ""} - ${row.title || ""}`,
      `- 评分：${row.score == null ? "-" : row.score}`,
      `- 等级：${row.tier || "-"}`,
      `- 薪资：${row.salary_text || "-"}`,
      `- 地点：${row.city || "-"}`,
      `- 采集：${row.first_seen_date || "-"} ~ ${row.last_seen_date || "-"}`,
      `- 理由：${row.score_explanation || "-"}`,
      `- 链接：${row.job_url || "-"}`,
      ""
    );
  }
  const content = lines.join("\n");
  const result = db.prepare(
    `INSERT INTO reports(report_date, role_uuid, channel, status, content, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`
  ).run(date, role.role_uuid, String(input.channel || role.report_channel_id || ""), content, nowIso());
  return db.prepare("SELECT * FROM reports WHERE id = ?").get(result.lastInsertRowid);
}

async function sendReport(db, id, options = {}) {
  const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
  if (!report) throw new Error("日报不存在");
  const sender = options.sender;
  if (typeof sender !== "function") throw new Error("缺少日报发送函数");
  const role = getRole(db, report.role_uuid);
  try {
    const result = await sender({ report, role });
    db.prepare("UPDATE reports SET status = 'sent', sent_at = ? WHERE id = ?").run(nowIso(), id);
    return { ok: true, result, report };
  } catch (error) {
    db.prepare("UPDATE reports SET status = 'failed' WHERE id = ?").run(id);
    return { ok: false, error: error.message, report };
  }
}

async function sendFeishu(webhook, text) {
  if (!webhook) throw new Error("未配置飞书 webhook");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`飞书 HTTP ${response.status}`);
  return { ok: true, status: response.status };
}

function cleanupReports(db, days = 14) {
  const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
  return Number(db.prepare("DELETE FROM reports WHERE created_at < ?").run(cutoff).changes || 0);
}

function listReports(db, options = {}) {
  const clauses = [];
  const params = [];
  if (options.roleUuid) {
    clauses.push("role_uuid = ?");
    params.push(options.roleUuid);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  return db.prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
}

module.exports = { reportRows, buildReport, sendReport, sendFeishu, cleanupReports, listReports };
