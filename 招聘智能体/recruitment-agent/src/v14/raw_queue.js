const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { shanghaiDateKey } = require("../core/time_utils");

const RAW_FILE_PATTERN = /^(boss|liepin)_(?:daily_\d{8}_jobs_.*|stage1_jobs_\d{4}-\d{2}-\d{2}T.*)\.json$/i;

function nowIso() {
  return new Date().toISOString();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizePlatform(value, filePath = "") {
  const text = String(value || "").toLowerCase();
  if (text.includes("liepin") || text.includes("猎聘")) return "猎聘";
  if (text.includes("boss") || text.includes("直聘")) return "BOSS";
  return /liepin|猎聘/i.test(path.basename(filePath)) ? "猎聘" : "BOSS";
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maxCollectedAt(records) {
  let best = null;
  for (const row of records || []) {
    const date = validDate(row && row.collected_at);
    if (date && (!best || date > best)) best = date;
  }
  return best;
}

function inferCollectedAt(payload, filePath) {
  const fromRecords = maxCollectedAt(payload && payload.records);
  if (fromRecords) return fromRecords.toISOString();
  const fromPayload = validDate(payload && payload.collected_at);
  if (fromPayload) return fromPayload.toISOString();
  const stat = fs.statSync(filePath);
  return stat.mtime.toISOString();
}

function inferDateKey(payload, collectedAt) {
  if (payload && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.dateKey || ""))) {
    return String(payload.dateKey);
  }
  return shanghaiDateKey(new Date(collectedAt));
}

function listRawJsonFiles(outputsDir) {
  if (!fs.existsSync(outputsDir)) return [];
  return fs
    .readdirSync(outputsDir)
    .filter((name) => RAW_FILE_PATTERN.test(name))
    .map((name) => path.join(outputsDir, name));
}

function registerRawFile(db, input) {
  const filePath = path.resolve(input.filePath);
  const existing = db.prepare("SELECT * FROM raw_files WHERE file_path = ?").get(filePath);
  if (existing) {
    if (existing.status === "done" || existing.status === "archived") {
      return { action: "skipped", file: existing };
    }
    db.prepare(
      `UPDATE raw_files
       SET platform = ?, collected_at = ?, date_key = ?, record_count = ?, content_hash = ?
       WHERE id = ?`
    ).run(
      input.platform,
      input.collectedAt,
      input.dateKey,
      Number(input.recordCount || 0),
      input.contentHash || "",
      existing.id
    );
    return { action: "updated", file: db.prepare("SELECT * FROM raw_files WHERE id = ?").get(existing.id) };
  }

  const result = db.prepare(
    `INSERT INTO raw_files
      (platform, file_path, collected_at, date_key, status, attempts, record_count, content_hash, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).run(
    input.platform,
    filePath,
    input.collectedAt,
    input.dateKey,
    Number(input.recordCount || 0),
    input.contentHash || "",
    nowIso()
  );
  return {
    action: "registered",
    file: db.prepare("SELECT * FROM raw_files WHERE id = ?").get(result.lastInsertRowid),
  };
}

function inspectRawFile(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const records = Array.isArray(payload.records) ? payload.records : [];
  const collectedAt = inferCollectedAt(payload, filePath);
  const platform = normalizePlatform(payload.platform || (records[0] && records[0].platform), filePath);
  return {
    filePath: path.resolve(filePath),
    platform,
    collectedAt,
    dateKey: inferDateKey(payload, collectedAt),
    recordCount: records.length,
    contentHash: sha256File(filePath),
    payload,
  };
}

function fallbackInspectRawFile(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^(\d{4})(\d{2})(\d{2})/);
  const stat = fs.statSync(filePath);
  const collectedAt = stat.mtime.toISOString();
  return {
    filePath: path.resolve(filePath),
    platform: normalizePlatform("", filePath),
    collectedAt,
    dateKey: match ? `${match[1]}-${match[2]}-${match[3]}` : shanghaiDateKey(new Date(collectedAt)),
    recordCount: 0,
    contentHash: sha256File(filePath),
    payload: null,
  };
}

function discoverRawFiles(db, options = {}) {
  const outputsDir = path.resolve(options.outputsDir || path.join(__dirname, "..", "..", "outputs"));
  const results = [];
  for (const filePath of listRawJsonFiles(outputsDir)) {
    try {
      const inspected = inspectRawFile(filePath);
      const result = registerRawFile(db, inspected);
      results.push({ ...result, filePath, platform: inspected.platform });
    } catch (error) {
      const fallback = fallbackInspectRawFile(filePath);
      const result = registerRawFile(db, fallback);
      results.push({
        ...result,
        filePath,
        platform: fallback.platform,
        action: result.action === "registered" ? "registered_invalid" : result.action,
        error: error.message,
      });
    }
  }
  return results;
}

function listDueRawFiles(db, options = {}) {
  const limit = Math.max(1, Number(options.limit || 50));
  return db
    .prepare(
      `SELECT * FROM raw_files
       WHERE status IN ('pending', 'failed')
       ORDER BY COALESCE(collected_at, created_at) ASC, id ASC
       LIMIT ?`
    )
    .all(limit);
}

function claimRawFile(db, id) {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM raw_files WHERE id = ?").get(id);
    if (!current || !["pending", "failed"].includes(current.status)) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(
      "UPDATE raw_files SET status = 'processing', attempts = attempts + 1, last_error = NULL WHERE id = ?"
    ).run(id);
    db.exec("COMMIT");
    return db.prepare("SELECT * FROM raw_files WHERE id = ?").get(id);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }
}

function markRawDone(db, id, counts = {}) {
  db.prepare(
    `UPDATE raw_files
     SET status = 'done', ingested_count = ?, pending_count = ?, processed_at = ?, last_error = NULL
     WHERE id = ?`
  ).run(Number(counts.ingested || 0), Number(counts.pending || 0), nowIso(), id);
}

function markRawFailed(db, id, error) {
  db.prepare(
    "UPDATE raw_files SET status = 'failed', last_error = ?, processed_at = ? WHERE id = ?"
  ).run(String(error || "").slice(0, 2000), nowIso(), id);
}

function resetStaleProcessing(db, olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - Number(olderThanMinutes) * 60000).toISOString();
  const result = db.prepare(
    `UPDATE raw_files
     SET status = 'failed', last_error = 'stale processing reset'
     WHERE status = 'processing' AND COALESCE(processed_at, created_at) < ?`
  ).run(cutoff);
  return Number(result.changes || 0);
}

function rawFileCounts(db) {
  return db.prepare("SELECT status, COUNT(*) AS count FROM raw_files GROUP BY status").all();
}

module.exports = {
  RAW_FILE_PATTERN,
  normalizePlatform,
  inferCollectedAt,
  inferDateKey,
  inspectRawFile,
  discoverRawFiles,
  registerRawFile,
  listDueRawFiles,
  claimRawFile,
  markRawDone,
  markRawFailed,
  resetStaleProcessing,
  rawFileCounts,
  sha256File,
};
