const fs = require("fs");
const path = require("path");
const { nowIso } = require("./jobs_repo");

const AI_SIGNALS = /AI|智能体|大模型|Agent|AIGC/i;
const LEGACY_STRATEGY = path.resolve(__dirname, "..", "..", "config", "search_strategy.json");

function legacyKeywords() {
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_STRATEGY, "utf8"));
    const levels = Array.isArray(data.levels) ? data.levels : [];
    const jobLevel = levels.find((level) => level.type === "岗位信息");
    const broadLevel = levels.find((level) => level.type === "宽泛词");
    return {
      recommended: (jobLevel?.keywords || []).slice(0, 8),
      fallback: (broadLevel?.keywords || []).filter((item) => item.length >= 4).slice(0, 6),
    };
  } catch {
    return { recommended: [], fallback: [] };
  }
}

function splitTargets(input = {}) {
  return String(input.target_roles || "")
    .split(/[、,，/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(list, limit = 20) {
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].slice(0, limit);
}

function fallbackKeywords(input = {}) {
  const targets = splitTargets(input);
  const text = `${targets.join(" ")} ${input.career_expectation || ""} ${input.profile_md || ""}`;
  const recommended = [];
  const fallback = [];
  for (const target of targets) {
    recommended.push(target);
    if (AI_SIGNALS.test(text)) {
      recommended.push(`${target} 智能体`, `${target} 大模型`);
    }
    fallback.push(target);
  }
  if (AI_SIGNALS.test(text)) {
    recommended.push("AI Agent", "智能体交付", "大模型应用", "AI项目管理", "AI产品经理");
    fallback.push("AI项目交付", "智能体项目经理", "大模型项目经理", "AI产品负责人");
  }
  fallback.push("项目经理", "产品经理");
  const skills = Array.isArray(input.skills) ? input.skills : [];
  for (const skill of skills) if (String(skill).length <= 20) recommended.push(skill);
  const legacy = legacyKeywords();
  if (AI_SIGNALS.test(text)) {
    recommended.push(...legacy.recommended);
    fallback.push(...legacy.fallback);
  }
  return {
    recommended: unique(recommended, 12),
    fallback: unique(fallback.filter((item) => !recommended.includes(item)), 8),
  };
}

function history(db, roleUuid) {
  if (!roleUuid) return [];
  const rows = db.prepare(
    `SELECT k.keyword,
       SUM(k.seen) AS seen, SUM(k.new_count) AS new_count,
       SUM(k.duplicates) AS duplicate_count, SUM(k.failed) AS failed_count,
       MAX(k.started_at) AS last_used_at, COUNT(*) AS use_count
     FROM keyword_tasks k
     JOIN collection_subtasks s ON s.id = k.subtask_id
     WHERE s.role_uuid = ?
     GROUP BY LOWER(k.keyword)
     ORDER BY last_used_at DESC`
  ).all(roleUuid);
  return rows.map((row) => ({
    keyword: row.keyword,
    seen: Number(row.seen || 0),
    new: Number(row.new_count || 0),
    duplicates: Number(row.duplicate_count || 0),
    failed: Number(row.failed_count || 0),
    lastUsedAt: row.last_used_at || "",
    useCount: Number(row.use_count || 0),
  }));
}

function extractFallbackFromProfile(profileMd) {
  const text = String(profileMd || "");
  const match = text.match(/##\s*兜底关键词\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!match) return [];
  return unique(match[1].split(/[\n,，、]/).map((item) => item.replace(/^[-*\d.\s]+/, "").trim()), 8);
}

function save(db, roleUuid, result = {}) {
  if (!roleUuid) return null;
  const recommended = unique(result.recommended || result.keywords || [], 12);
  const fallback = unique(result.fallback || result.fallbackKeywords || [], 8);
  const now = nowIso();
  db.prepare("UPDATE role_keyword_entries SET is_current = 0 WHERE role_uuid = ?").run(roleUuid);
  const upsert = db.prepare(
    `INSERT INTO role_keyword_entries(role_uuid, keyword, category, is_current, priority, created_at, updated_at)
     VALUES(?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(role_uuid, keyword, category) DO UPDATE SET
       is_current = 1, priority = excluded.priority, updated_at = excluded.updated_at`
  );
  recommended.forEach((keyword, index) => upsert.run(roleUuid, keyword, "recommended", 100 - index, now, now));
  fallback.forEach((keyword, index) => upsert.run(roleUuid, keyword, "fallback", 50 - index, now, now));
  const active = unique([...recommended, ...fallback], 20);
  db.prepare("UPDATE roles SET role_keywords_json = ?, updated_at = ? WHERE role_uuid = ?")
    .run(JSON.stringify(active), now, roleUuid);
  refreshStats(db, roleUuid);
  return { recommended, fallback, active };
}

function refreshStats(db, roleUuid) {
  const rows = history(db, roleUuid);
  const update = db.prepare(
    `UPDATE role_keyword_entries SET last_used_at = ?, use_count = ?, seen_count = ?, new_count = ?,
       duplicate_count = ?, failed_count = ?, updated_at = ?
     WHERE role_uuid = ? AND keyword = ?`
  );
  for (const row of rows) {
    update.run(row.lastUsedAt, row.useCount, row.seen, row.new, row.duplicates, row.failed, nowIso(), roleUuid, row.keyword);
  }
}

function list(db, roleUuid) {
  return db.prepare(
    "SELECT * FROM role_keyword_entries WHERE role_uuid = ? ORDER BY is_current DESC, category ASC, priority DESC, id DESC"
  ).all(roleUuid).map((row) => ({ ...row, is_current: Boolean(row.is_current) }));
}

module.exports = { fallbackKeywords, extractFallbackFromProfile, history, save, list, splitTargets, unique };
