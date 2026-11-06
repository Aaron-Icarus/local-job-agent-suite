const { withTransaction } = require("./db");
const { nowIso } = require("./jobs_repo");
const { listRoles, getRole } = require("./roles_repo");

function jobUpdatedAt(job) {
  return [job.facts_updated_at, job.status_updated_at, job.ingested_at]
    .filter(Boolean)
    .sort()
    .pop() || "";
}

function snapshotFor(job) {
  return {
    job_display_id: job.display_id,
    job_status: job.job_status || "open",
    duplicate_status: job.duplicate_status || "unique",
    status_updated_at: job.status_updated_at || "",
    job_updated_at: jobUpdatedAt(job),
  };
}

function insertRoleJob(db, roleUuid, job, options = {}) {
  const now = options.now || nowIso();
  const snapshot = snapshotFor(job);
  const skipReason = snapshot.duplicate_status === "duplicate"
    ? "duplicate"
    : snapshot.job_status === "closed"
      ? "closed"
      : "";
  const needsScore = options.needsScore == null
    ? !skipReason
    : Number(Boolean(options.needsScore) && !skipReason);
  db.prepare(
    `INSERT INTO role_jobs(
      role_uuid, job_uuid, job_display_id, job_status, duplicate_status, status_updated_at,
      job_updated_at, score_id, score, tier, score_time, score_explanation, score_reasons_json,
      score_risks_json, note, greeting_status, score_version, candidate_version,
      needs_score, skip_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', NULL, '', '[]', '[]', '', '', '', '', ?, ?, ?, ?)
    ON CONFLICT(role_uuid, job_uuid) DO NOTHING`
  ).run(
    roleUuid,
    job.job_uuid,
    snapshot.job_display_id,
    snapshot.job_status,
    snapshot.duplicate_status,
    snapshot.status_updated_at,
    snapshot.job_updated_at,
    needsScore,
    skipReason,
    now,
    now
  );
}

function ensureRoleJobsForRole(db, roleUuid, options = {}) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) return 0;
  const jobs = db.prepare("SELECT * FROM jobs").all();
  let inserted = 0;
  withTransaction(db, () => {
    for (const job of jobs) {
      const before = db
        .prepare("SELECT 1 FROM role_jobs WHERE role_uuid = ? AND job_uuid = ?")
        .get(roleUuid, job.job_uuid);
      insertRoleJob(db, roleUuid, job, {
        needsScore: job.ingested_at > role.modified_at || !job.job_status || job.job_status === "open",
      });
      if (!before) inserted += 1;
    }
  });
  return inserted;
}

function ensureAllRoleJobs(db) {
  let count = 0;
  for (const role of listRoles(db)) count += ensureRoleJobsForRole(db, role.role_uuid);
  return count;
}

function syncJobToRoles(db, job, change = {}) {
  const roles = listRoles(db);
  const now = nowIso();
  const snapshot = snapshotFor(job);
  const duplicate = snapshot.duplicate_status === "duplicate";
  const closed = snapshot.job_status === "closed";
  const skipReason = duplicate ? "duplicate" : closed ? "closed" : "";
  let touched = 0;

  withTransaction(db, () => {
    for (const role of roles) {
      const existing = db
        .prepare("SELECT * FROM role_jobs WHERE role_uuid = ? AND job_uuid = ?")
        .get(role.role_uuid, job.job_uuid);
      if (!existing) {
        insertRoleJob(db, role.role_uuid, job, {
          needsScore: true,
          now,
        });
        touched += 1;
        continue;
      }
      const factsChanged = Boolean(change.factsChanged);
      const reopened = Boolean(change.reopened);
      const duplicateChanged = Boolean(change.duplicateChanged);
      const statusChanged = Boolean(change.statusChanged);
      let needsScore = Number(existing.needs_score || 0);
      let nextSkip = skipReason || existing.skip_reason || "";
      if (skipReason) {
        needsScore = 0;
        nextSkip = skipReason;
      } else if (factsChanged || reopened || duplicateChanged || statusChanged) {
        needsScore = 1;
        nextSkip = "";
      } else if (!existing.score_time || existing.score_time < role.modified_at) {
        needsScore = 1;
      }
      db.prepare(
        `UPDATE role_jobs SET
          job_display_id = ?, job_status = ?, duplicate_status = ?, status_updated_at = ?,
          job_updated_at = ?, needs_score = ?, skip_reason = ?, updated_at = ?
         WHERE role_uuid = ? AND job_uuid = ?`
      ).run(
        snapshot.job_display_id,
        snapshot.job_status,
        snapshot.duplicate_status,
        snapshot.status_updated_at,
        snapshot.job_updated_at,
        needsScore,
        nextSkip,
        now,
        role.role_uuid,
        job.job_uuid
      );
      touched += 1;
    }
  });
  return touched;
}

function markRoleNeedsScore(db, roleUuid, options = {}) {
  const role = getRole(db, roleUuid);
  if (!role) return 0;
  const now = nowIso();
  const condition = options.all
    ? "1 = 1"
    : "(score_time IS NULL OR score_time < ?)";
  const params = options.all ? [roleUuid] : [roleUuid, role.modified_at];
  const result = db.prepare(
    `UPDATE role_jobs SET needs_score = 1, skip_reason = '', updated_at = ?
     WHERE role_uuid = ? AND ${condition}
       AND job_uuid IN (
         SELECT job_uuid FROM jobs WHERE job_status <> 'closed' AND duplicate_status <> 'duplicate'
       )`
  ).run(now, ...params);
  return Number(result.changes || 0);
}

function selectJobsForScoring(db, roleUuid, options = {}) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) return [];
  ensureRoleJobsForRole(db, roleUuid);
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100)));
  return db
    .prepare(
      `SELECT j.*, rj.score_id, rj.score, rj.score_time, rj.needs_score, rj.skip_reason
       FROM jobs j
       JOIN role_jobs rj ON rj.job_uuid = j.job_uuid AND rj.role_uuid = ?
       WHERE j.job_status <> 'closed'
         AND j.duplicate_status <> 'duplicate'
         AND (
           rj.needs_score = 1
           OR rj.score IS NULL
           OR rj.score_time IS NULL
           OR rj.score_time < ?
         )
       ORDER BY
         MAX(COALESCE(j.facts_updated_at, ''), COALESCE(j.status_updated_at, ''), COALESCE(j.ingested_at, '')) DESC,
         j.ingested_at DESC,
         j.display_id DESC
       LIMIT ?`
    )
    .all(roleUuid, role.modified_at, limit);
}

function allocateScoreId(db, roleUuid) {
  const row = db.prepare("SELECT MAX(score_id) AS max_id FROM role_jobs WHERE role_uuid = ?").get(roleUuid);
  const current = db.prepare("SELECT next_no FROM role_score_seq WHERE role_uuid = ?").get(roleUuid);
  const next = Math.max(Number(row ? row.max_id : 0) || 0, Number(current ? current.next_no : 0) || 0) + 1;
  db.prepare(
    `INSERT INTO role_score_seq(role_uuid, next_no) VALUES(?, ?)
     ON CONFLICT(role_uuid) DO UPDATE SET next_no = excluded.next_no`
  ).run(roleUuid, next);
  return next;
}

function saveScore(db, roleUuid, jobUuid, score = {}) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) throw new Error("角色不存在或已删除");
  const job = db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobUuid);
  if (!job) throw new Error("岗位不存在");
  const now = score.scoreTime || nowIso();
  return withTransaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM role_jobs WHERE role_uuid = ? AND job_uuid = ?")
      .get(roleUuid, jobUuid);
    if (!existing) {
      insertRoleJob(db, roleUuid, job, { needsScore: true, now });
    }
    const scoreId = existing && existing.score_id ? existing.score_id : allocateScoreId(db, roleUuid);
    db.prepare(
      `UPDATE role_jobs SET
        score_id = ?, score = ?, tier = ?, score_time = ?, score_explanation = ?,
        score_reasons_json = ?, score_risks_json = ?, note = ?, greeting_status = ?,
        score_version = ?, candidate_version = ?, needs_score = 0, skip_reason = '',
        job_status = ?, duplicate_status = ?, status_updated_at = ?, job_updated_at = ?, updated_at = ?
       WHERE role_uuid = ? AND job_uuid = ?`
    ).run(
      scoreId,
      score.score == null ? null : Number(score.score),
      String(score.tier || ""),
      now,
      String(score.explanation || ""),
      JSON.stringify(score.reasons || []),
      JSON.stringify(score.risks || []),
      String(score.note || ""),
      String(score.greetingStatus || ""),
      String(score.scoreVersion || ""),
      String(score.candidateVersion || ""),
      job.job_status || "open",
      job.duplicate_status || "unique",
      job.status_updated_at || "",
      jobUpdatedAt(job),
      now,
      roleUuid,
      jobUuid
    );
    return getRoleJob(db, roleUuid, jobUuid);
  });
}

function getRoleJob(db, roleUuid, jobUuid) {
  return db
    .prepare(
      `SELECT rj.*, j.job_uuid, j.display_id, j.company, j.title, j.job_url, j.salary_text,
              j.city, j.district, j.job_description, j.first_seen_date, j.last_seen_date,
              j.ingested_at, j.job_status AS main_job_status, j.duplicate_status AS main_duplicate_status
       FROM role_jobs rj
       JOIN jobs j ON j.job_uuid = rj.job_uuid
       WHERE rj.role_uuid = ? AND rj.job_uuid = ?`
    )
    .get(roleUuid, jobUuid) || null;
}

function listRoleJobs(db, roleUuid, options = {}) {
  const clauses = ["rj.role_uuid = ?"];
  const params = [roleUuid];
  if (options.needsScore != null) {
    clauses.push("rj.needs_score = ?");
    params.push(Number(Boolean(options.needsScore)));
  }
  if (options.status) {
    clauses.push("j.job_status = ?");
    params.push(options.status);
  }
  if (options.duplicateStatus) {
    clauses.push("j.duplicate_status = ?");
    params.push(options.duplicateStatus);
  }
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100)));
  return db
    .prepare(
      `SELECT rj.*, j.display_id, j.company, j.title, j.job_url, j.salary_text, j.city,
              j.first_seen_date, j.last_seen_date, j.ingested_at,
              j.job_status AS main_job_status, j.duplicate_status AS main_duplicate_status
       FROM role_jobs rj
       JOIN jobs j ON j.job_uuid = rj.job_uuid
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(rj.job_updated_at, j.ingested_at) DESC
       LIMIT ?`
    )
    .all(...params, limit);
}

function countPendingScores(db, roleUuid) {
  return Number(
    db.prepare(
      `SELECT COUNT(*) AS count FROM role_jobs rj
       JOIN jobs j ON j.job_uuid = rj.job_uuid
       WHERE rj.role_uuid = ? AND rj.needs_score = 1
         AND j.job_status <> 'closed' AND j.duplicate_status <> 'duplicate'`
    ).get(roleUuid).count || 0
  );
}

function searchRoleJobs(db, roleUuid, options = {}) {
  const clauses = ["rj.role_uuid = ?"];
  const params = [roleUuid];
  const q = String(options.q || "").trim();
  if (q) {
    clauses.push("(j.display_id LIKE ? OR j.company LIKE ? OR j.title LIKE ? OR j.job_description LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const location = String(options.location || "").trim();
  if (location) {
    clauses.push("(j.city LIKE ? OR j.district LIKE ? OR j.address LIKE ?)");
    const like = `%${location}%`;
    params.push(like, like, like);
  }
  if (options.salaryMin !== "" && options.salaryMin != null) {
    clauses.push("(j.salary_max_k IS NULL OR j.salary_max_k >= ?)");
    params.push(Number(options.salaryMin));
  }
  if (options.salaryMax !== "" && options.salaryMax != null) {
    clauses.push("(j.salary_min_k IS NULL OR j.salary_min_k <= ?)");
    params.push(Number(options.salaryMax));
  }
  if (options.dateFrom) {
    clauses.push("j.last_seen_date >= ?");
    params.push(String(options.dateFrom));
  }
  if (options.dateTo) {
    clauses.push("j.last_seen_date <= ?");
    params.push(String(options.dateTo));
  }
  const where = clauses.join(" AND ");
  const sortMap = {
    score_desc: "rj.score DESC, rj.score_time DESC",
    date_desc: "j.last_seen_date DESC, j.display_id DESC",
    salary_desc: "j.salary_max_k DESC, j.salary_min_k DESC",
    salary_asc: "j.salary_min_k ASC, j.salary_max_k ASC",
    company_asc: "j.company ASC, j.display_id ASC",
  };
  const order = sortMap[options.sort] || sortMap.score_desc;
  const pageSize = Math.max(1, Math.min(200, Number(options.pageSize || 20)));
  const page = Math.max(1, Number(options.page || 1));
  const total = Number(
    db.prepare(
      `SELECT COUNT(*) AS count FROM role_jobs rj JOIN jobs j ON j.job_uuid = rj.job_uuid WHERE ${where}`
    ).get(...params).count || 0
  );
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const jobs = db.prepare(
    `SELECT rj.*, j.display_id, j.company, j.title, j.job_url, j.salary_text, j.city, j.district,
            j.first_seen_date, j.last_seen_date, j.ingested_at, j.job_status AS main_job_status,
            j.duplicate_status AS main_duplicate_status, j.long_lived_days
     FROM role_jobs rj
     JOIN jobs j ON j.job_uuid = rj.job_uuid
     WHERE ${where}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (safePage - 1) * pageSize);
  return { jobs, total, page: safePage, pageSize, pages };
}

module.exports = {
  jobUpdatedAt,
  ensureRoleJobsForRole,
  ensureAllRoleJobs,
  syncJobToRoles,
  markRoleNeedsScore,
  selectJobsForScoring,
  saveScore,
  getRoleJob,
  listRoleJobs,
  searchRoleJobs,
  countPendingScores,
};
