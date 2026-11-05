const fs = require("fs");
const os = require("os");
const path = require("path");
const { getRole } = require("./roles_repo");

function defaultExportDir() {
  return process.env.V14_EXPORT_DIR || path.join(os.homedir(), "Downloads");
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exportRows(db, roleUuid) {
  return db.prepare(
    `SELECT rj.*, j.display_id, j.company, j.title, j.salary_text, j.city, j.district,
            j.first_seen_date, j.last_seen_date, j.ingested_at, j.job_status, j.duplicate_status,
            j.long_lived_days, j.job_url
     FROM role_jobs rj
     JOIN jobs j ON j.job_uuid = rj.job_uuid
     WHERE rj.role_uuid = ?
     ORDER BY rj.score DESC, j.last_seen_date DESC`
  ).all(roleUuid);
}

function buildExcelHtml(db, roleUuid) {
  const role = getRole(db, roleUuid);
  if (!role) throw new Error("角色不存在");
  const rows = exportRows(db, roleUuid);
  const headers = [
    "岗位UUID", "编号", "平台", "公司", "岗位", "薪资", "城市", "区", "首次采集", "最近采集",
    "入库时间", "状态", "重复", "长期天数", "评分", "等级", "评分时间", "理由", "风险", "备注", "链接",
  ];
  const body = rows.map((row) => {
    const url = row.job_url || "";
    return `<tr>
      <td>${escapeHtml(row.job_uuid)}</td>
      <td>${escapeHtml(row.display_id)}</td>
      <td>${escapeHtml(row.platform || "")}</td>
      <td>${escapeHtml(row.company)}</td>
      <td>${escapeHtml(row.title)}</td>
      <td>${escapeHtml(row.salary_text)}</td>
      <td>${escapeHtml(row.city)}</td>
      <td>${escapeHtml(row.district)}</td>
      <td>${escapeHtml(row.first_seen_date)}</td>
      <td>${escapeHtml(row.last_seen_date)}</td>
      <td>${escapeHtml(row.ingested_at)}</td>
      <td>${escapeHtml(row.job_status)}</td>
      <td>${escapeHtml(row.duplicate_status)}</td>
      <td>${escapeHtml(row.long_lived_days)}</td>
      <td>${escapeHtml(row.score)}</td>
      <td>${escapeHtml(row.tier)}</td>
      <td>${escapeHtml(row.score_time)}</td>
      <td>${escapeHtml(row.score_explanation)}</td>
      <td>${escapeHtml(row.score_risks_json)}</td>
      <td>${escapeHtml(row.note)}</td>
      <td>${url ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : ""}</td>
    </tr>`;
  });
  return `<html><head><meta charset="utf-8"><title>${escapeHtml(role.role_number)} ${escapeHtml(role.nickname)} 岗位</title></head>
<body><table border="1"><thead><tr>${headers.map((item) => `<th>${item}</th>`).join("")}</tr></thead>
<tbody>${body.join("")}</tbody></table></body></html>`;
}

function exportRoleToExcel(db, roleUuid, options = {}) {
  const role = getRole(db, roleUuid);
  if (!role) throw new Error("角色不存在");
  const dir = options.outputDir || defaultExportDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${role.role_number}_${role.nickname}_jobs_${stamp}.xls`);
  const html = buildExcelHtml(db, roleUuid);
  fs.writeFileSync(filePath, `\ufeff${html}`, "utf8");
  return { filePath, count: exportRows(db, roleUuid).length };
}

module.exports = { defaultExportDir, buildExcelHtml, exportRoleToExcel };
