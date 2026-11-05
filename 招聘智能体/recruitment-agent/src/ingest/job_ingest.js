const fs = require("fs");
const path = require("path");
const { loadEnv, envNumber } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../core/field_dictionary");
const {
  loadJobStore,
  saveJobStore,
  ingestFacts,
  jobStoreKey,
  platformName,
  platformKey,
} = require("../store/job_store");
const { loadNumbering, saveNumbering } = require("../store/job_numbering");
const { appendLedgerEntries } = require("../store/collection_ledger");
const { writeJsonAtomic } = require("../core/atomic_json");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(rootDir, "outputs");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function inferPlatform(payload, inputPath) {
  if (payload.platform) return payload.platform;
  const first = (payload.records || [])[0] || {};
  if (first.platform) return first.platform;
  return /liepin|猎聘/i.test(path.basename(inputPath)) ? "猎聘" : "BOSS";
}

function platformJobId(row) {
  return String(row.platform_job_id || row.job_id || row.boss_job_id || row.liepin_job_id || "").trim();
}

function hasFullJd(row, minJdLength) {
  const jd = String(row.job_description || "").trim();
  return jd.length >= minJdLength;
}

function validateRow(row, minJdLength) {
  const reasons = [];
  if (!platformJobId(row)) reasons.push("缺少平台岗位唯一 ID");
  if (!hasFullJd(row, minJdLength)) reasons.push(`缺少完整 JD（少于 ${minJdLength} 字）`);
  const status = String(row.detail_status || row.collection_status || "");
  if (status !== "ok") reasons.push(`详情状态不是 ok（${status || "未知"}）`);
  return reasons;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeOutputs(platform, dateKey, records, pending, summary) {
  fs.mkdirSync(outputsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = /猎聘|liepin/i.test(platform) ? "liepin" : "boss";
  const jsonPath = path.join(outputsDir, `${prefix}_stage2_ingested_${stamp}.json`);
  const csvPath = path.join(outputsDir, `${prefix}_stage2_ingested_${stamp}.csv`);
  const pendingPath = path.join(outputsDir, `${prefix}_pending_${stamp}.json`);
  const payload = { platform, dateKey, stage: "ingested", records, pending, summary, complete: true };
  writeJsonAtomic(jsonPath, payload);
  writeJsonAtomic(pendingPath, { platform, dateKey, pending });
  const headers = [
    "job_store_key", "display_id", "platform", "platform_job_id", "company", "job_title", "salary",
    "salary_min_k", "salary_max_k", "city", "district", "address", "job_url", "source_keyword",
    "source_page", "detail_status", "collection_status", "record_status", "duplicate_of_display_id",
    "job_description", "collected_at",
  ];
  const lines = [
    headers.map((header) => csvCell(fieldZh[header] || header)).join(","),
    headers.map(csvCell).join(","),
    headers.map((header) => csvCell(fieldDescriptions[header] || "")).join(","),
    ...records.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  fs.writeFileSync(csvPath, `\ufeff${lines.join("\r\n")}`, "utf8");
  return { jsonPath, csvPath, pendingPath };
}

function aggregateIngestLedger(platform, dateKey, records, pending) {
  const byKeyword = new Map();
  const bucket = (keyword) => {
    const key = String(keyword || "未标注关键词");
    if (!byKeyword.has(key)) byKeyword.set(key, { keyword: key, primary: 0, duplicate: 0, pending: 0, updated: 0 });
    return byKeyword.get(key);
  };
  for (const row of records) {
    const item = bucket(row.source_keyword || row.keyword);
    if (!row.is_new) item.updated += 1;
    else if (row.record_status === "duplicate") item.duplicate += 1;
    else item.primary += 1;
  }
  for (const row of pending) bucket(row.source_keyword || row.keyword).pending += 1;
  return [...byKeyword.values()].map((item) => ({
    date: dateKey,
    stage: "ingest",
    channel: platformName({ platform }),
    keyword: item.keyword,
    ingested_primary: item.primary,
    ingested_duplicate: item.duplicate,
    pending_confirmed: item.pending,
    updated_existing: item.updated,
    stop_reason: "ingest_done",
  }));
}

function ingestRecords(records, options = {}) {
  const dateKey = options.dateKey || shanghaiDateKey();
  const minJdLength = Number(options.minJdLength || envNumber("INGEST_MIN_JD_CHARS", 60));
  const store = options.store || loadJobStore(options.storePath);
  const numberingState = options.numberingState || loadNumbering(options.numberingPath);
  const recordsOut = [];
  const pending = [];
  const seen = new Set();
  let updated = 0;
  let duplicateInInput = 0;

  for (const row of records || []) {
    const reasons = validateRow(row, minJdLength);
    if (reasons.length) {
      pending.push({
        ...row,
        pending_reasons: reasons,
        source_keyword: row.source_keyword || row.keyword || "",
        source_page: row.source_page || row.page || "",
      });
      continue;
    }
    // 唯一键固定为“渠道 + 平台岗位 ID”，不接受外部 record_key 改写，避免跨渠道串键。
    const canonicalRow = { ...row, record_key: `${platformKey(row)}:${platformJobId(row)}` };
    const key = jobStoreKey(canonicalRow);
    if (seen.has(key)) {
      duplicateInInput += 1;
      continue;
    }
    seen.add(key);
    const result = ingestFacts(store, canonicalRow, {
      dateKey,
      now: options.now,
      numberingState,
      numberingPath: options.numberingPath,
      duplicateThreshold: options.duplicateThreshold,
    });
    if (!result.accepted) {
      pending.push({ ...canonicalRow, pending_reasons: [result.reason] });
      continue;
    }
    if (!result.isNew) updated += 1;
    const entry = store.jobs[result.key];
    recordsOut.push({
      ...canonicalRow,
      job_store_key: result.key,
      display_id: result.displayId,
      is_new: Boolean(result.isNew),
      record_status: result.recordStatus || entry?.record_status || "active",
      duplicate_of_display_id: result.duplicateOfDisplayId || entry?.duplicate_of_display_id || "",
      facts: result.facts || entry?.facts || null,
    });
  }

  const summary = {
    input_records: (records || []).length,
    new_primary: recordsOut.filter((row) => row.is_new && row.record_status !== "duplicate").length,
    new_duplicate: recordsOut.filter((row) => row.is_new && row.record_status === "duplicate").length,
    updated_existing: updated,
    duplicate_in_input: duplicateInInput,
    pending: pending.length,
  };
  return { store, numberingState, records: recordsOut, pending, summary };
}

function main() {
  const inputPaths = process.argv.slice(2).filter((arg) => arg.endsWith(".json") && !arg.startsWith("--"));
  if (!inputPaths.length) throw new Error("Usage: node src/ingest/job_ingest.js <raw.json...> --date=YYYY-MM-DD");
  const dateKey = argValue("date", process.env.EVALUATION_DATE || shanghaiDateKey());
  const storePath = argValue("store", process.env.JOB_STORE_PATH || "");
  const payloads = inputPaths.map((inputPath) => ({
    inputPath,
    payload: JSON.parse(fs.readFileSync(inputPath, "utf8")),
  }));
  const allResults = [];
  let store = loadJobStore(storePath || undefined);
  const numberingState = loadNumbering();

  for (const { inputPath, payload } of payloads) {
    const platform = inferPlatform(payload, inputPath);
    const rows = (payload.records || []).map((row) => ({
      ...row,
      platform,
      source_page: row.source_page || row.page || payload.page || "",
    }));
    const result = ingestRecords(rows, {
      store,
      numberingState,
      dateKey,
      storePath: storePath || undefined,
    });
    store = result.store;
    const outputs = writeOutputs(platform, dateKey, result.records, result.pending, result.summary);
    const ledgerEntries = aggregateIngestLedger(platform, dateKey, result.records, result.pending);
    appendLedgerEntries(dateKey, ledgerEntries);
    allResults.push({
      platform,
      inputPath,
      ...outputs,
      summary: result.summary,
      ledgerEntries,
    });
  }

  store.runs = store.runs || [];
  store.runs.push({
    at: new Date().toISOString(),
    dateKey,
    action: "ingest_facts",
    inputs: allResults.map((item) => ({ platform: item.platform, inputPath: item.inputPath, summary: item.summary })),
  });
  store.runs = store.runs.slice(-200);
  saveJobStore(store, storePath || undefined);
  if (allResults.some((item) => item.summary.new_primary + item.summary.new_duplicate > 0)) {
    saveNumbering(numberingState);
  }
  console.log(JSON.stringify({
    stage: "ingested",
    dateKey,
    results: allResults,
    totalNewPrimary: allResults.reduce((sum, item) => sum + item.summary.new_primary, 0),
    totalNewDuplicate: allResults.reduce((sum, item) => sum + item.summary.new_duplicate, 0),
    totalPending: allResults.reduce((sum, item) => sum + item.summary.pending, 0),
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { ingestRecords, validateRow, inferPlatform, aggregateIngestLedger };
