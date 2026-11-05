const roles = require("./roles_repo");
const scores = require("./scores_repo");

function createRole(db, input = {}) {
  const role = roles.createRole(db, input);
  scores.ensureRoleJobsForRole(db, role.role_uuid);
  const similar = roles.findSimilarRoles(db, input, { excludeRoleUuid: role.role_uuid });
  return { role: roles.getRole(db, role.role_uuid), similar };
}

function updateRole(db, roleUuid, patch = {}) {
  const role = roles.updateRole(db, roleUuid, patch);
  scores.markRoleNeedsScore(db, roleUuid);
  const similar = roles.findSimilarRoles(db, role, { excludeRoleUuid: roleUuid });
  return { role: roles.getRole(db, roleUuid), similar };
}

function confirmRole(db, roleUuid, options = {}) {
  const role = roles.getRole(db, roleUuid);
  if (!role) throw new Error("角色不存在");
  if (role.has_started) throw new Error("角色已启动，不能重新确认");
  const similar = roles.findSimilarRoles(db, role, {
    excludeRoleUuid: roleUuid,
    threshold: options.threshold,
  });
  const confirmed = roles.confirmRole(db, roleUuid);
  scores.markRoleNeedsScore(db, roleUuid);
  return { role: confirmed, similar, forced: Boolean(options.force && similar.length) };
}

function startRole(db, roleUuid) {
  const role = roles.startRole(db, roleUuid);
  scores.ensureRoleJobsForRole(db, roleUuid);
  return role;
}

function pauseRole(db, roleUuid) {
  return roles.pauseRole(db, roleUuid);
}

function softDeleteRole(db, roleUuid) {
  return roles.softDeleteRole(db, roleUuid);
}

function copyRole(db, roleUuid, overrides = {}) {
  const role = roles.copyRole(db, roleUuid, overrides);
  scores.ensureRoleJobsForRole(db, role.role_uuid);
  return role;
}

function listRoles(db) {
  return roles.listRoles(db).map((role) => ({
    ...role,
    pending_scores: scores.countPendingScores(db, role.role_uuid),
  }));
}

function getRole(db, roleUuid) {
  const role = roles.getRole(db, roleUuid);
  if (!role) return null;
  return {
    ...role,
    pending_scores: scores.countPendingScores(db, roleUuid),
  };
}

function migrateLegacyScores(db, roleUuid) {
  const role = roles.getRole(db, roleUuid);
  if (!role) throw new Error("角色不存在");
  scores.ensureRoleJobsForRole(db, roleUuid);
  const jobs = db.prepare("SELECT * FROM jobs WHERE legacy_score_json IS NOT NULL").all();
  let migrated = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const legacy = JSON.parse(job.legacy_score_json || "null");
      if (!legacy) continue;
      scores.saveScore(db, roleUuid, job.job_uuid, {
        score: legacy.overall ?? legacy.score,
        scoreTime: job.ingested_at || undefined,
        explanation: legacy.explanation || legacy.match_summary || "",
        reasons: legacy.reasons || [],
        risks: legacy.risks || [],
        note: "从 v1.3 迁移",
        scoreVersion: legacy.rule_version || "v1.3",
        candidateVersion: legacy.candidate_version || "",
      });
      migrated += 1;
    } catch {
      failed += 1;
    }
  }
  // 迁移来的评分不应因为“角色创建时间”而被全部判为过期。
  db.prepare("UPDATE roles SET modified_at = ? WHERE role_uuid = ?").run(
    "1970-01-01T00:00:00.000Z",
    roleUuid
  );
  return { migrated, failed };
}

function ensureDefaultRoleForMigration(db, options = {}) {
  const existing = roles.listRoles(db, { includeDeleted: true });
  if (existing.length) return existing[0];
  const role = roles.createRole(db, {
    nickname: options.nickname || "默认角色（v1.3 迁移）",
    profile_md: options.profile_md || "由 v1.3 迁移生成，请补充简历与目标岗位。",
    target_roles: options.target_roles || "",
    role_channels: options.role_channels || ["BOSS", "猎聘"],
  });
  scores.ensureRoleJobsForRole(db, role.role_uuid);
  return roles.getRole(db, role.role_uuid);
}

module.exports = {
  MAX_ACTIVE_ROLES: roles.MAX_ACTIVE_ROLES,
  similarityScore: roles.similarityScore,
  listRoles,
  getRole,
  createRole,
  updateRole,
  confirmRole,
  startRole,
  pauseRole,
  softDeleteRole,
  copyRole,
  migrateLegacyScores,
  ensureDefaultRoleForMigration,
};
