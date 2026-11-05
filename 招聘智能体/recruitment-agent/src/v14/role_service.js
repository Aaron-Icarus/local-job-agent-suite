const roles = require("./roles_repo");
const scores = require("./scores_repo");
const { importResume, getResume, profileForResume } = require("./resumes_repo");

const VALID_CHANNELS = new Set(["BOSS", "猎聘"]);

function normalizeChannels(channels) {
  const result = [...new Set((channels || []).map((item) => String(item).trim()).filter((item) => VALID_CHANNELS.has(item)))];
  if (!result.length) throw new Error("确认角色时至少选择一个渠道（BOSS/猎聘）");
  return result;
}

function createRole(db, input = {}) {
  let resumeId = String(input.resume_id || "");
  let profile = String(input.profile_md || "");
  if (!resumeId && input.resume_md) {
    const resume = importResume(db, {
      name: input.nickname,
      content: input.resume_md,
      fileName: input.resume_file_name || "",
    });
    resumeId = resume.id;
  }
  if (resumeId) {
    const resume = getResume(db, resumeId);
    if (!resume) throw new Error("简历不存在");
    if (!profile) profile = profileForResume(resume);
  }
  const role = roles.createRole(db, {
    ...input,
    resume_id: resumeId,
    profile_md: profile,
    role_channels: input.role_channels || [],
  });
  scores.ensureRoleJobsForRole(db, role.role_uuid);
  const similar = roles.findSimilarRoles(db, { ...input, profile_md: profile }, { excludeRoleUuid: role.role_uuid });
  return { role: roles.getRole(db, role.role_uuid), similar };
}

function updateRole(db, roleUuid, patch = {}) {
  const role = roles.updateRole(db, roleUuid, patch);
  scores.markRoleNeedsScore(db, roleUuid);
  const similar = roles.findSimilarRoles(db, role, { excludeRoleUuid: roleUuid });
  return { role: roles.getRole(db, roleUuid), similar };
}

function confirmRole(db, roleUuid, options = {}) {
  let role = roles.getRole(db, roleUuid);
  if (!role) throw new Error("角色不存在");
  if (role.has_started) throw new Error("角色已启动，不能重新确认");
  if (options.channels !== undefined) {
    const channels = normalizeChannels(options.channels);
    const updated = roles.updateRole(db, roleUuid, { role_channels: channels });
    role = updated;
  }
  const similar = roles.findSimilarRoles(db, role, {
    excludeRoleUuid: roleUuid,
    threshold: options.threshold,
  });
  const confirmed = roles.confirmRole(db, roleUuid);
  scores.markRoleNeedsScore(db, roleUuid);
  return { role: confirmed, similar, forced: Boolean(options.force && similar.length) };
}

function startRole(db, roleUuid) {
  const current = roles.getRole(db, roleUuid);
  if (!current) throw new Error("角色不存在");
  if (!Array.isArray(current.role_channels) || !current.role_channels.length) {
    throw new Error("角色未选择渠道，请先确认 BOSS/猎聘");
  }
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
