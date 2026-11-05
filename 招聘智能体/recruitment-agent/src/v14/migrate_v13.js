const fs = require("fs");
const path = require("path");
const { shanghaiDateKey, daysBetweenDateKeys } = require("../core/time_utils");
const { withTransaction, getMeta, setMeta } = require("./db");
const { upsertJob, reseedNumbering, countJobs, nowIso } = require("./jobs_repo");

function parseDate(value, fallback = new Date()) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function valueOf(entry, facts, keys, fallback = "") {
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== "") return entry[key];
    if (facts[key] !== undefined && facts[key] !== null && facts[key] !== "") return facts[key];
  }
  return fallback;
}

function migrateEntry(db, entry) {
  if (!entry) return { action: "skipped", reason: "empty" };
  const facts = entry.facts || {};
  const platform = String(entry.platform || facts.platform || "").trim();
  const platformJobId = String(
    entry.platform_job_id || facts.platform_job_id || entry.record_key || ""
  ).trim();
  if (!platform || !platformJobId) return { action: "skipped", reason: "missing identity" };

  const existing = db
    .prepare("SELECT job_uuid FROM jobs WHERE platform = ? AND platform_job_id = ?")
    .get(platform, platformJobId);
  if (existing) return { action: "skipped", reason: "already migrated", jobUuid: existing.job_uuid };

  const firstSeen = parseDate(
    valueOf(entry, facts, ["first_seen_at", "collected_at", "ingested_at"], nowIso())
  );
  const lastSeen = parseDate(valueOf(entry, facts, ["last_seen_at", "first_seen_at"], firstSeen.toISOString()));
  const ingested = parseDate(valueOf(entry, facts, ["ingested_at"], firstSeen.toISOString()));
  const collected = valueOf(entry, facts, ["collected_at"], firstSeen.toISOString());

  const row = {
    ...facts,
    ...entry,
    platform,
    platform_job_id: platformJobId,
    collected_at: collected,
  };
  const outcome = upsertJob(db, row, {
    platform,
    collectedAt: collected,
    sourceAccountId: valueOf(entry, facts, ["source_account_id", "account_id"], ""),
    now: ingested.toISOString(),
  });
  if (outcome.action !== "inserted") return { action: "skipped", reason: "not inserted" };

  const firstDate = shanghaiDateKey(firstSeen);
  const lastDate = shanghaiDateKey(lastSeen);
  const longLived = Math.max(0, daysBetweenDateKeys(firstDate, shanghaiDateKey()) || 0);
  const displayId = String(entry.display_id || outcome.job.display_id);
  const duplicateStatus = entry.record_status === "duplicate" ? "duplicate" : "unique";
  const scoreJson = entry.score == null ? null : JSON.stringify(entry.score);

  // 迁移时保留旧编号/时间/评分；新库的编号仍通过 reseedNumbering 对齐。
  try {
    db.prepare(
      `UPDATE jobs SET
        display_id = ?, first_seen_at = ?, first_seen_date = ?, last_seen_at = ?, last_seen_date = ?,
        ingested_at = ?, content_hash = ?, job_status = ?, status_updated_at = ?, closed_at = ?,
        reopen_count = ?, duplicate_status = ?, duplicate_score = ?, long_lived_days = ?,
        legacy_score_json = ?, facts_json = ?, updated_at = ?
       WHERE job_uuid = ?`
    ).run(
      displayId,
      firstSeen.toISOString(),
      firstDate,
      lastSeen.toISOString(),
      lastDate,
      ingested.toISOString(),
      valueOf(entry, facts, ["content_hash"], outcome.job.content_hash),
      valueOf(entry, facts, ["job_status"], "open"),
      valueOf(entry, facts, ["status_updated_at", "status_checked_at"], lastSeen.toISOString()),
      valueOf(entry, facts, ["closed_at"], ""),
      Number(entry.reopen_count || 0),
      duplicateStatus,
      Number(entry.duplicate_score || 0),
      longLived,
      scoreJson,
      JSON.stringify(row),
      nowIso(),
      outcome.job.job_uuid
    );
  } catch (error) {
    // 编号冲突时保留新分配的编号，不让迁移整体失败。
    db.prepare("UPDATE jobs SET legacy_score_json = ? WHERE job_uuid = ?").run(
      scoreJson,
      outcome.job.job_uuid
    );
  }

  return { action: "inserted", jobUuid: outcome.job.job_uuid, displayId };
}

function migrateV13Store(db, storePath, options = {}) {
  const filePath = path.resolve(storePath);
  const store = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const entries = Object.entries(store.jobs || {});
  const result = { inserted: 0, skipped: 0, failed: 0, errors: [] };

  withTransaction(db, () => {
    for (const [key, entry] of entries) {
      try {
        const outcome = migrateEntry(db, entry);
        if (outcome.action === "inserted") result.inserted += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ key, error: error.message });
      }
    }
    reseedNumbering(db);
    setMeta(db, "v13_migrated_at", nowIso());
    setMeta(db, "v13_source", filePath);
  });

  result.total = countJobs(db);
  result.migratedAt = getMeta(db, "v13_migrated_at", "");
  return result;
}

module.exports = { migrateV13Store, migrateEntry };
