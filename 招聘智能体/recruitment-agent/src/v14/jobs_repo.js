const crypto = require("crypto");
const { shanghaiDateKey, shanghaiDateTime, daysBetweenDateKeys } = require("../core/time_utils");
const { platformPrefix, formatDisplayId, parseDisplayNumber } = require("../store/job_numbering");

const CONTENT_FIELDS = [
  "job_url",
  "company",
  "job_title",
  "title",
  "salary",
  "salary_text",
  "salary_min_k",
  "salary_max_k",
  "salary_months",
  "city",
  "district",
  "business_area",
  "address",
  "experience",
  "degree",
  "tags",
  "skills",
  "job_description",
  "latest_active_date",
  "boss_online",
];

function nowIso() {
  return new Date().toISOString();
}

function stableValue(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(stableValue).filter(Boolean).join("; ");
  return String(value).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => stableValue(item)).filter(Boolean));
  if (value === undefined || value === null) return "[]";
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function platformJobId(row) {
  return stableValue(
    row.platform_job_id || row.job_id || row.boss_job_id || row.liepin_job_id || ""
  );
}

function contentHash(row) {
  const payload = {};
  for (const field of CONTENT_FIELDS) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== "") {
      payload[field] = row[field];
    }
  }
  payload.platform_job_id = platformJobId(row);
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateRecord(row, minJdLength = 60) {
  const reasons = [];
  if (!platformJobId(row)) reasons.push("缺少平台岗位唯一 ID");
  const jd = stableValue(row.job_description);
  if (jd.length < Number(minJdLength)) reasons.push(`缺少完整 JD（少于 ${minJdLength} 字）`);
  const detailStatus = stableValue(row.detail_status || row.collection_status);
  if (detailStatus !== "ok") reasons.push(`详情状态不是 ok（${detailStatus || "未知"}）`);
  return reasons;
}

function ensureNumberingTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS job_numbering (platform TEXT PRIMARY KEY, next_no INTEGER NOT NULL)");
}

function allocateDisplayId(db, platform) {
  ensureNumberingTable(db);
  const prefix = platformPrefix(platform);
  const rows = db.prepare("SELECT display_id FROM jobs WHERE display_id LIKE ?").all(`${prefix}%`);
  const maxInStore = rows.reduce((max, row) => Math.max(max, parseDisplayNumber(row.display_id, prefix)), 0);
  const current = db.prepare("SELECT next_no FROM job_numbering WHERE platform = ?").get(prefix);
  const next = Math.max(Number(current ? current.next_no : 0), maxInStore, 0) + 1;
  db.prepare(
    `INSERT INTO job_numbering(platform, next_no) VALUES(?, ?)
     ON CONFLICT(platform) DO UPDATE SET next_no = excluded.next_no`
  ).run(prefix, next);
  return formatDisplayId(prefix, next);
}

function firstValue(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return stableValue(row[key]);
  }
  return "";
}

function jobValues(row, platform, collectedAt, sourceAccountId) {
  const title = firstValue(row, "job_title", "title", "position");
  const salaryText = firstValue(row, "salary_text", "salary");
  return {
    platform,
    platform_job_id: platformJobId(row),
    job_url: firstValue(row, "job_url", "url", "link"),
    company: firstValue(row, "company", "company_name"),
    title,
    salary_text: salaryText,
    salary_min_k: row.salary_min_k == null ? null : Number(row.salary_min_k),
    salary_max_k: row.salary_max_k == null ? null : Number(row.salary_max_k),
    salary_months: firstValue(row, "salary_months"),
    city: firstValue(row, "city"),
    district: firstValue(row, "district", "business_area"),
    address: firstValue(row, "address", "business_area", "city"),
    experience: firstValue(row, "experience"),
    degree: firstValue(row, "degree"),
    skills_json: stableJson(row.skills),
    tags_json: stableJson(row.tags),
    job_description: stableValue(row.job_description),
    source_account_id: stableValue(sourceAccountId || row.source_account_id || row.account_id),
    collected_at: collectedAt,
    content_hash: contentHash(row),
    facts_json: JSON.stringify(row),
  };
}

function upsertJob(db, row, options = {}) {
  const platform = options.platform || row.platform || "";
  const collectedAt = options.collectedAt || row.collected_at || nowIso();
  const now = options.now || nowIso();
  const dateKey = shanghaiDateKey(new Date(collectedAt));
  const values = jobValues(row, platform, collectedAt, options.sourceAccountId);

  const existing = db
    .prepare("SELECT * FROM jobs WHERE platform = ? AND platform_job_id = ?")
    .get(platform, values.platform_job_id);

  if (existing) {
    const factsChanged = existing.content_hash !== values.content_hash;
    const reopened = existing.job_status === "closed" || existing.job_status === "unknown";
    const firstSeenAt = existing.first_seen_at && existing.first_seen_at < collectedAt
      ? existing.first_seen_at
      : collectedAt;
    const lastSeenAt = existing.last_seen_at && existing.last_seen_at > collectedAt
      ? existing.last_seen_at
      : collectedAt;
    const firstSeenDate = shanghaiDateKey(new Date(firstSeenAt));
    const lastSeenDate = shanghaiDateKey(new Date(lastSeenAt));
    const longLived = Math.max(0, daysBetweenDateKeys(firstSeenDate, shanghaiDateKey()) || 0);

    db.prepare(
      `UPDATE jobs SET
        job_url = ?, company = ?, title = ?, salary_text = ?, salary_min_k = ?, salary_max_k = ?,
        salary_months = ?, city = ?, district = ?, address = ?, experience = ?, degree = ?,
        skills_json = ?, tags_json = ?, job_description = ?, source_account_id = ?,
        collected_at = ?, first_seen_at = ?, first_seen_date = ?, last_seen_at = ?, last_seen_date = ?,
        ingested_at = ?, content_hash = ?, facts_updated_at = ?, job_status = ?,
        status_updated_at = ?, closed_at = ?, reopen_count = ?, long_lived_days = ?,
        facts_json = ?, updated_at = ?
       WHERE job_uuid = ?`
    ).run(
      values.job_url,
      values.company,
      values.title,
      values.salary_text,
      values.salary_min_k,
      values.salary_max_k,
      values.salary_months,
      values.city,
      values.district,
      values.address,
      values.experience,
      values.degree,
      values.skills_json,
      values.tags_json,
      values.job_description,
      values.source_account_id,
      values.collected_at,
      firstSeenAt,
      firstSeenDate,
      lastSeenAt,
      lastSeenDate,
      now,
      values.content_hash,
      factsChanged ? now : existing.facts_updated_at,
      "open",
      reopened ? now : existing.status_updated_at,
      "",
      Number(existing.reopen_count || 0) + (reopened ? 1 : 0),
      longLived,
      values.facts_json,
      now,
      existing.job_uuid
    );
    return {
      action: "updated",
      job: db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(existing.job_uuid),
      factsChanged,
      reopened,
    };
  }

  const displayId = allocateDisplayId(db, platform);
  const jobUuid = crypto.randomUUID();
  const firstSeenDate = dateKey;
  const longLived = Math.max(0, daysBetweenDateKeys(firstSeenDate, shanghaiDateKey()) || 0);
  db.prepare(
    `INSERT INTO jobs (
      job_uuid, display_id, platform, platform_job_id, job_url, company, title, salary_text,
      salary_min_k, salary_max_k, salary_months, city, district, address, experience, degree,
      skills_json, tags_json, job_description, source_account_id, collected_at,
      first_seen_at, first_seen_date, last_seen_at, last_seen_date, ingested_at,
      content_hash, facts_updated_at, job_status, status_updated_at, closed_at, reopen_count,
      duplicate_of_job_uuid, duplicate_status, duplicate_score, long_lived_days, facts_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, '', 0, '', 'unique', 0, ?, ?, ?, ?)`
  ).run(
    jobUuid,
    displayId,
    platform,
    values.platform_job_id,
    values.job_url,
    values.company,
    values.title,
    values.salary_text,
    values.salary_min_k,
    values.salary_max_k,
    values.salary_months,
    values.city,
    values.district,
    values.address,
    values.experience,
    values.degree,
    values.skills_json,
    values.tags_json,
    values.job_description,
    values.source_account_id,
    values.collected_at,
    collectedAt,
    firstSeenDate,
    collectedAt,
    firstSeenDate,
    now,
    values.content_hash,
    now,
    now,
    longLived,
    values.facts_json,
    now,
    now
  );
  return {
    action: "inserted",
    job: db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobUuid),
    factsChanged: true,
    reopened: false,
  };
}

function getJob(db, jobUuid) {
  return db.prepare("SELECT * FROM jobs WHERE job_uuid = ?").get(jobUuid) || null;
}

function listJobs(db, options = {}) {
  const clauses = [];
  const params = [];
  if (options.platform) {
    clauses.push("platform = ?");
    params.push(options.platform);
  }
  if (options.status) {
    clauses.push("job_status = ?");
    params.push(options.status);
  }
  if (options.duplicateStatus) {
    clauses.push("duplicate_status = ?");
    params.push(options.duplicateStatus);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100)));
  return db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, limit);
}

function countJobs(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count || 0);
}

function reseedNumbering(db) {
  ensureNumberingTable(db);
  const prefixes = db.prepare("SELECT DISTINCT substr(display_id, 1, 1) AS prefix FROM jobs").all();
  for (const row of prefixes) {
    const prefix = row.prefix;
    const max = db
      .prepare("SELECT display_id FROM jobs WHERE display_id LIKE ?")
      .all(`${prefix}%`)
      .reduce((value, item) => Math.max(value, parseDisplayNumber(item.display_id, prefix)), 0);
    db.prepare(
      `INSERT INTO job_numbering(platform, next_no) VALUES(?, ?)
       ON CONFLICT(platform) DO UPDATE SET next_no = MAX(next_no, excluded.next_no)`
    ).run(prefix, max);
  }
}

function updateLongLivedDays(db, today = shanghaiDateKey()) {
  const rows = db.prepare("SELECT job_uuid, first_seen_date FROM jobs").all();
  const update = db.prepare("UPDATE jobs SET long_lived_days = ? WHERE job_uuid = ?");
  let changed = 0;
  for (const row of rows) {
    const days = daysBetweenDateKeys(row.first_seen_date, today) || 0;
    update.run(days, row.job_uuid);
    changed += 1;
  }
  return changed;
}

module.exports = {
  CONTENT_FIELDS,
  stableValue,
  contentHash,
  validateRecord,
  platformJobId,
  allocateDisplayId,
  upsertJob,
  getJob,
  listJobs,
  countJobs,
  reseedNumbering,
  updateLongLivedDays,
  nowIso,
  shanghaiDateTime,
};
