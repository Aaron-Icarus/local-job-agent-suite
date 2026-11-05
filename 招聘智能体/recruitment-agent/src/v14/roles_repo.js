const crypto = require("crypto");
const { withTransaction } = require("./db");

const MAX_ACTIVE_ROLES = 3;
const ROLE_NUMBER_SCOPE = "R";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。；、,.;:!?！？"'“”‘’()（）[\]【】]/g, "");
}

function featureSet(text) {
  const normalized = normalizeText(text);
  const set = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    set.add(normalized.slice(index, index + 2));
  }
  return set;
}

function similarityScore(left, right) {
  const a = featureSet(left);
  const b = featureSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? Number((intersection / union).toFixed(4)) : 0;
}

function roleText(role) {
  return [
    role.profile_md,
    role.target_roles,
    role.target_city,
    role.target_salary,
    role.special_requirements,
    role.role_keywords_json,
  ].join("\n");
}

function rowToRole(row) {
  if (!row) return null;
  return {
    ...row,
    has_started: Boolean(row.has_started),
    role_keywords: safeJson(row.role_keywords_json, []),
    role_channels: safeJson(row.role_channels_json, []),
  };
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function listRoles(db, options = {}) {
  const where = options.includeDeleted ? "" : "WHERE deleted_at IS NULL";
  const order = "ORDER BY role_number ASC";
  return db.prepare(`SELECT * FROM roles ${where} ${order}`).all().map(rowToRole);
}

function getRole(db, roleUuid) {
  return rowToRole(db.prepare("SELECT * FROM roles WHERE role_uuid = ?").get(roleUuid));
}

function countActiveRoles(db) {
  return Number(
    db.prepare("SELECT COUNT(*) AS count FROM roles WHERE deleted_at IS NULL").get().count || 0
  );
}

function nextRoleNumber(db) {
  const rows = db.prepare("SELECT role_number FROM roles").all();
  let max = 0;
  for (const row of rows) {
    const match = String(row.role_number || "").match(/^R(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const current = db.prepare("SELECT next_no FROM role_numbering WHERE scope = ?").get(ROLE_NUMBER_SCOPE);
  const next = Math.max(max, Number(current ? current.next_no : 0), 0) + 1;
  db.prepare(
    `INSERT INTO role_numbering(scope, next_no) VALUES(?, ?)
     ON CONFLICT(scope) DO UPDATE SET next_no = excluded.next_no`
  ).run(ROLE_NUMBER_SCOPE, next);
  return `R${String(next).padStart(3, "0")}`;
}

function logEvent(db, roleUuid, eventType, detail = {}) {
  db.prepare(
    "INSERT INTO role_events(role_uuid, event_type, detail_json, created_at) VALUES(?, ?, ?, ?)"
  ).run(roleUuid, eventType, JSON.stringify(detail), nowIso());
}

function assertWritable(role) {
  if (!role || role.deleted_at) throw new Error("角色不存在或已删除");
  if (role.has_started) throw new Error("角色首次启动后不可修改；请复制角色");
}

function createRole(db, input = {}) {
  const nickname = String(input.nickname || "").trim();
  if (!nickname) throw new Error("角色昵称不能为空");
  if (countActiveRoles(db) >= MAX_ACTIVE_ROLES) throw new Error("最多只能有 3 个角色");
  const now = nowIso();
  const roleUuid = crypto.randomUUID();
  return withTransaction(db, () => {
    const roleNumber = nextRoleNumber(db);
    db.prepare(
      `INSERT INTO roles(
        role_uuid, role_number, nickname, status, profile_md, resume_source, target_roles,
        target_city, target_salary, special_requirements, role_keywords_json, role_channels_json,
        collection_weight, ai_provider_id, report_channel_id, has_started, created_at, updated_at,
        confirmed_at, modified_at, first_started_at, deleted_at
      ) VALUES (?, ?, ?, 'pending_confirm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, NULL)`
    ).run(
      roleUuid,
      roleNumber,
      nickname,
      String(input.profile_md || ""),
      String(input.resume_source || ""),
      String(input.target_roles || ""),
      String(input.target_city || ""),
      String(input.target_salary || ""),
      String(input.special_requirements || ""),
      JSON.stringify(input.role_keywords || []),
      JSON.stringify(input.role_channels || []),
      Number(input.collection_weight == null ? 1 : input.collection_weight),
      String(input.ai_provider_id || ""),
      String(input.report_channel_id || ""),
      now,
      now,
      now
    );
    logEvent(db, roleUuid, "created", { roleNumber, nickname });
    return getRole(db, roleUuid);
  });
}

function updateRole(db, roleUuid, patch = {}) {
  const role = getRole(db, roleUuid);
  assertWritable(role);
  const now = nowIso();
  return withTransaction(db, () => {
    const allowed = {
      nickname: patch.nickname,
      profile_md: patch.profile_md,
      resume_source: patch.resume_source,
      target_roles: patch.target_roles,
      target_city: patch.target_city,
      target_salary: patch.target_salary,
      special_requirements: patch.special_requirements,
      role_keywords_json: patch.role_keywords === undefined ? undefined : JSON.stringify(patch.role_keywords),
      role_channels_json: patch.role_channels === undefined ? undefined : JSON.stringify(patch.role_channels),
      collection_weight: patch.collection_weight,
      ai_provider_id: patch.ai_provider_id,
      report_channel_id: patch.report_channel_id,
    };
    const fields = [];
    const values = [];
    for (const [column, value] of Object.entries(allowed)) {
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (!fields.length) return role;
    fields.push("status = 'pending_confirm'", "modified_at = ?", "updated_at = ?");
    values.push(now, now, roleUuid);
    db.prepare(`UPDATE roles SET ${fields.join(", ")} WHERE role_uuid = ?`).run(...values);
    logEvent(db, roleUuid, "updated", { fields: Object.keys(patch) });
    return getRole(db, roleUuid);
  });
}

function confirmRole(db, roleUuid) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) throw new Error("角色不存在或已删除");
  if (role.has_started) throw new Error("角色已启动，不能重新确认");
  const now = nowIso();
  return withTransaction(db, () => {
    db.prepare(
      "UPDATE roles SET status = 'pending_start', confirmed_at = ?, modified_at = ?, updated_at = ? WHERE role_uuid = ?"
    ).run(now, now, now, roleUuid);
    logEvent(db, roleUuid, "confirmed", {});
    return getRole(db, roleUuid);
  });
}

function startRole(db, roleUuid) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) throw new Error("角色不存在或已删除");
  if (!["pending_start", "paused", "running"].includes(role.status)) {
    throw new Error(`当前状态不能启动：${role.status}`);
  }
  if (role.status === "running") return role;
  const now = nowIso();
  return withTransaction(db, () => {
    const first = !role.has_started;
    db.prepare(
      `UPDATE roles SET
        status = 'running',
        has_started = 1,
        first_started_at = COALESCE(first_started_at, ?),
        updated_at = ?
       WHERE role_uuid = ?`
    ).run(now, now, roleUuid);
    logEvent(db, roleUuid, "started", { firstStart: first });
    return getRole(db, roleUuid);
  });
}

function pauseRole(db, roleUuid) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) throw new Error("角色不存在或已删除");
  if (role.status !== "running") throw new Error("只有运行中的角色可以暂停");
  const now = nowIso();
  return withTransaction(db, () => {
    db.prepare("UPDATE roles SET status = 'paused', updated_at = ? WHERE role_uuid = ?").run(now, roleUuid);
    logEvent(db, roleUuid, "paused", {});
    return getRole(db, roleUuid);
  });
}

function softDeleteRole(db, roleUuid) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) throw new Error("角色不存在或已删除");
  const now = nowIso();
  return withTransaction(db, () => {
    db.prepare("UPDATE roles SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE role_uuid = ?").run(
      now,
      now,
      roleUuid
    );
    logEvent(db, roleUuid, "soft_deleted", {});
    return getRole(db, roleUuid);
  });
}

function copyRole(db, roleUuid, overrides = {}) {
  const source = getRole(db, roleUuid);
  if (!source || source.deleted_at) throw new Error("角色不存在或已删除");
  return createRole(db, {
    nickname: overrides.nickname || `${source.nickname} 副本`,
    profile_md: source.profile_md,
    resume_source: source.resume_source,
    target_roles: source.target_roles,
    target_city: source.target_city,
    target_salary: source.target_salary,
    special_requirements: source.special_requirements,
    role_keywords: source.role_keywords,
    role_channels: source.role_channels,
    collection_weight: source.collection_weight,
    ai_provider_id: source.ai_provider_id,
    report_channel_id: source.report_channel_id,
  });
}

function findSimilarRoles(db, input = {}, options = {}) {
  const threshold = Number(options.threshold == null ? 0.75 : options.threshold);
  const exclude = options.excludeRoleUuid || "";
  const text = [
    input.profile_md,
    input.target_roles,
    input.target_city,
    input.target_salary,
    input.special_requirements,
    input.role_keywords,
  ].join("\n");
  const matches = [];
  for (const role of listRoles(db)) {
    if (role.role_uuid === exclude) continue;
    const score = similarityScore(text, roleText(role));
    if (score >= threshold) {
      matches.push({ role_uuid: role.role_uuid, role_number: role.role_number, nickname: role.nickname, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

module.exports = {
  MAX_ACTIVE_ROLES,
  similarityScore,
  listRoles,
  getRole,
  countActiveRoles,
  createRole,
  updateRole,
  confirmRole,
  startRole,
  pauseRole,
  softDeleteRole,
  copyRole,
  findSimilarRoles,
};
