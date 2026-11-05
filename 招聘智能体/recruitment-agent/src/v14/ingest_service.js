const fs = require("fs");
const path = require("path");
const { withTransaction } = require("./db");
const { validateRecord, upsertJob, nowIso } = require("./jobs_repo");
const {
  discoverRawFiles,
  listDueRawFiles,
  claimRawFile,
  markRawDone,
  markRawFailed,
  resetStaleProcessing,
} = require("./raw_queue");
const { shanghaiDateKey } = require("../core/time_utils");

function minJdLength(value) {
  const number = Number(value || process.env.INGEST_MIN_JD_CHARS || 60);
  return Number.isFinite(number) && number > 0 ? number : 60;
}

function insertPending(db, rawFile, row, reasons) {
  const platform = row.platform || rawFile.platform;
  const jobId = String(row.platform_job_id || row.job_id || row.boss_job_id || row.liepin_job_id || "");
  db.prepare(
    `INSERT INTO pending_jobs(raw_file_id, platform, platform_job_id, payload_json, reasons_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(rawFile.id, platform, jobId, JSON.stringify(row), JSON.stringify(reasons), nowIso());
}

function readPayload(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ingestRawFile(db, rawFile, options = {}) {
  const startedAt = nowIso();
  const payload = readPayload(rawFile.file_path);
  const records = Array.isArray(payload.records) ? payload.records : [];
  const platform = payload.platform || rawFile.platform;
  const accountId = payload.account_id || payload.source_account_id || "";
  const minJd = minJdLength(options.minJdLength);
  const result = {
    rawFileId: rawFile.id,
    filePath: rawFile.file_path,
    platform,
    recordCount: records.length,
    inserted: 0,
    updated: 0,
    pending: 0,
    reopened: 0,
    factsChanged: 0,
  };

  withTransaction(db, () => {
    for (const row of records) {
      const reasons = validateRecord(row, minJd);
      if (reasons.length) {
        insertPending(db, rawFile, row, reasons);
        result.pending += 1;
        continue;
      }
      const collectedAt = row.collected_at || rawFile.collected_at || nowIso();
      const outcome = upsertJob(db, { ...row, platform }, {
        platform,
        collectedAt,
        sourceAccountId: row.source_account_id || row.account_id || accountId,
        now: startedAt,
      });
      if (outcome.action === "inserted") result.inserted += 1;
      else result.updated += 1;
      if (outcome.reopened) result.reopened += 1;
      if (outcome.factsChanged) result.factsChanged += 1;
    }

    db.prepare(
      `INSERT INTO ingest_runs
        (raw_file_id, platform, file_path, status, record_count, ingested_count, pending_count, error, started_at, finished_at)
       VALUES (?, ?, ?, 'success', ?, ?, ?, NULL, ?, ?)`
    ).run(
      rawFile.id,
      platform,
      rawFile.file_path,
      result.recordCount,
      result.inserted + result.updated,
      result.pending,
      startedAt,
      nowIso()
    );
    markRawDone(db, rawFile.id, {
      ingested: result.inserted + result.updated,
      pending: result.pending,
    });
  });

  result.status = "success";
  return result;
}

function processRawQueue(db, options = {}) {
  const runId = nowIso();
  const summary = {
    runId,
    discovered: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    records: 0,
    inserted: 0,
    updated: 0,
    pending: 0,
    results: [],
  };

  if (options.discover !== false) {
    const discovered = discoverRawFiles(db, { outputsDir: options.outputsDir });
    summary.discovered = discovered.length;
    summary.discoveryErrors = discovered.filter((item) => item.action === "error");
  }

  const stale = resetStaleProcessing(db, options.staleMinutes || 30);
  summary.staleReset = stale;

  const due = listDueRawFiles(db, { limit: options.limit || 50 });
  for (const item of due) {
    const claimed = claimRawFile(db, item.id);
    if (!claimed) continue;
    summary.claimed += 1;
    try {
      const result = ingestRawFile(db, claimed, options);
      summary.succeeded += 1;
      summary.records += result.recordCount;
      summary.inserted += result.inserted;
      summary.updated += result.updated;
      summary.pending += result.pending;
      summary.results.push(result);
    } catch (error) {
      summary.failed += 1;
      markRawFailed(db, claimed.id, error.stack || error.message);
      db.prepare(
        `INSERT INTO ingest_runs
          (raw_file_id, platform, file_path, status, record_count, ingested_count, pending_count, error, started_at, finished_at)
         VALUES (?, ?, ?, 'failed', 0, 0, 0, ?, ?, ?)`
      ).run(claimed.id, claimed.platform, claimed.file_path, error.message, nowIso(), nowIso());
      summary.results.push({ rawFileId: claimed.id, status: "failed", error: error.message });
    }
  }
  return summary;
}

module.exports = {
  minJdLength,
  ingestRawFile,
  processRawQueue,
  shanghaiDateKey,
};
