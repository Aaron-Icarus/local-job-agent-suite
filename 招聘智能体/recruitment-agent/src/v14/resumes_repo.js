const crypto = require("crypto");
const { nowIso } = require("./jobs_repo");
const { parseResumeMarkdown, resumeToProfileMarkdown } = require("./resume_parser");

function rowToResume(row) {
  if (!row) return null;
  let parsed = {};
  try {
    parsed = JSON.parse(row.parsed_json || "{}");
  } catch {
    parsed = {};
  }
  return { ...row, parsed };
}

function listResumes(db) {
  return db
    .prepare("SELECT id, name, source_type, file_name, file_path, content_hash, created_at, updated_at FROM resumes ORDER BY created_at DESC")
    .all();
}

function getResume(db, id) {
  return rowToResume(db.prepare("SELECT * FROM resumes WHERE id = ?").get(id));
}

function importResume(db, input = {}) {
  const content = String(input.content || input.markdown || "").trim();
  if (!content) throw new Error("简历 MD 内容为空");
  const parsed = parseResumeMarkdown(content);
  const id = String(input.id || crypto.randomUUID());
  const now = nowIso();
  const existing = db.prepare("SELECT * FROM resumes WHERE id = ?").get(id);
  db.prepare(
    `INSERT INTO resumes(id, name, source_type, file_name, file_path, raw_md, parsed_json, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, source_type = excluded.source_type, file_name = excluded.file_name,
       file_path = excluded.file_path,
       raw_md = excluded.raw_md, parsed_json = excluded.parsed_json,
       content_hash = excluded.content_hash, updated_at = excluded.updated_at`
  ).run(
    id,
    String(input.name || parsed.name || "未命名简历"),
    String(input.sourceType || "md"),
    String(input.fileName || ""),
    String(input.filePath || ""),
    content,
    JSON.stringify(parsed),
    parsed.content_hash,
    existing?.created_at || now,
    now
  );
  return getResume(db, id);
}

function deleteResume(db, id) {
  return Number(db.prepare("DELETE FROM resumes WHERE id = ?").run(id).changes || 0);
}

function profileForResume(resume) {
  if (!resume) return "";
  return resumeToProfileMarkdown(resume.parsed || {});
}

module.exports = { listResumes, getResume, importResume, deleteResume, profileForResume };
