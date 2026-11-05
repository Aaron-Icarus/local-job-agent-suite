const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../core/field_dictionary");
const { loadCandidateFacts, loadScoringRules } = require("./candidate_facts");
const { scoreJob, deriveFocus } = require("./score_job_facts");
const { reviewScores } = require("./ai_score_review");
const { loadJobStore, saveJobStore } = require("../store/job_store");
const { writeJsonAtomic } = require("../core/atomic_json");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(rootDir, "outputs");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function platformOf(row) {
  return row.platform || (row.liepin_job_id ? "猎聘" : "BOSS");
}

function rowsFromStore(store, options = {}) {
  const platform = String(options.platform || "").toLowerCase();
  const rows = [];
  for (const [key, entry] of Object.entries(store.jobs || {})) {
    if (entry.record_status === "pending") continue;
    if (platform && !(entry.platform || "").toLowerCase().includes(platform) && !(platform === "boss" && entry.platform === "BOSS") && !(platform === "liepin" && entry.platform === "猎聘")) continue;
    const facts = entry.facts || {};
    rows.push({
      ...facts,
      facts,
      job_store_key: key,
      platform: entry.platform,
      display_id: entry.display_id,
      record_status: entry.record_status || "active",
      duplicate_of_display_id: entry.duplicate_of_display_id || "",
      salary: facts.salary_text || entry.salary || "",
      job_description: facts.job_description || "",
      city: facts.city || entry.city || "",
      district: facts.district || entry.district || "",
      latest_active_date: facts.latest_active_date || entry.latest_active_date || "",
      collection_status: facts.detail_status || "ok",
      first_seen_at: entry.first_seen_at,
      ingested_at: entry.ingested_at,
    });
  }
  return rows;
}

function scoreRecords(records, options = {}) {
  const candidate = options.candidate;
  const rules = options.rules;
  const ruleVersion = options.ruleVersion || "";
  const candidateVersion = options.candidateVersion || "";
  const dateKey = options.dateKey || shanghaiDateKey();
  const deterministic = (records || []).map((row) => scoreJob(row, candidate, rules, { ruleVersion, candidateVersion, dateKey }));
  return { rows: deterministic, ruleVersion, candidateVersion };
}

function writeOutputs(platform, dateKey, rows, summary) {
  fs.mkdirSync(outputsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = /猎聘|liepin/i.test(platform) ? "liepin" : "boss";
  const jsonPath = path.join(outputsDir, `${prefix}_stage3_scored_${stamp}.json`);
  const csvPath = path.join(outputsDir, `${prefix}_stage3_scored_${stamp}.csv`);
  const payload = {
    platform,
    dateKey,
    stage: "scored",
    evaluation_version: "fit_eval_v4_facts",
    records: rows,
    summary,
    complete: true,
  };
  writeJsonAtomic(jsonPath, payload);
  const headers = [
    "job_store_key", "display_id", "platform", "company", "job_title", "salary", "city", "district",
    "focus_level", "overall_fit_score", "application_success_score", "hard_status", "hard_failures",
    "reasons", "risks", "ai_status", "ai_delta", "recommendation", "job_url",
  ];
  const lines = [
    headers.map((header) => csvCell(fieldZh[header] || header)).join(","),
    headers.map(csvCell).join(","),
    headers.map((header) => csvCell(fieldDescriptions[header] || "")).join(","),
    ...rows.map((row) => {
      const score = row.score || {};
      return [
        row.job_store_key, row.display_id, row.platform, row.company, row.job_title, row.salary, row.city, row.district,
        row.focus_level, row.overall_fit_score, row.application_success_score, score.hard?.status || "",
        (score.hard?.failures || []).join("；"), (score.reasons || []).join("；"), (score.risks || []).join("；"),
        score.ai?.status || "", score.ai?.delta || 0, row.application_recommendation, row.job_url,
      ].map(csvCell).join(",");
    }),
  ];
  fs.writeFileSync(csvPath, `\ufeff${lines.join("\r\n")}`, "utf8");
  return { jsonPath, csvPath };
}

function updateStoreScores(store, rows, options = {}) {
  let updated = 0;
  for (const row of rows) {
    const entry = store.jobs[row.job_store_key];
    if (!entry) continue;
    entry.score = row.score;
    entry.overall_fit_score = row.overall_fit_score;
    entry.application_success_score = row.application_success_score;
    entry.focus_level = row.focus_level;
    entry.application_recommendation = row.application_recommendation;
    entry.evaluation_summary = row.evaluation_summary;
    entry.match_reasons_json = row.match_reasons_json;
    entry.risk_reasons_json = row.risk_reasons_json;
    entry.evaluation_date = row.evaluation_date;
    entry.evaluation_version = "fit_eval_v4_facts";
    entry.scored_at = row.score?.scored_at || new Date().toISOString();
    updated += 1;
  }
  if (updated) {
    store.runs = store.runs || [];
    store.runs.push({
      at: new Date().toISOString(),
      dateKey: options.dateKey || shanghaiDateKey(),
      action: "score_jobs",
      updated,
      ruleVersion: options.ruleVersion || "",
      candidateVersion: options.candidateVersion || "",
      ai: options.aiSummary || null,
    });
    store.runs = store.runs.slice(-200);
  }
  return updated;
}

async function main() {
  const inputPaths = process.argv.slice(2).filter((arg) => arg.endsWith(".json") && !arg.startsWith("--"));
  const fromStore = flag("from-store") || flag("all");
  const dateKey = argValue("date", process.env.EVALUATION_DATE || shanghaiDateKey());
  const storePath = argValue("store", process.env.JOB_STORE_PATH || "");
  const platform = argValue("platform", "") || (inputPaths[0] ? (/liepin/i.test(inputPaths[0]) ? "猎聘" : "BOSS") : "");
  const limit = Number(argValue("limit", "0")) || 0;
  const useAi = !flag("no-ai") && /^(1|true|yes|on)$/i.test(String(process.env.AI_SCORE_REVIEW_ENABLED || "false"));
  if (!inputPaths.length && !fromStore) {
    throw new Error("Usage: node src/evaluate/score_jobs.js <ingested.json...> | --from-store [--platform=BOSS] [--date=YYYY-MM-DD] [--no-ai]");
  }

  const { facts: candidate, version: candidateVersion } = loadCandidateFacts();
  const { rules, version: ruleVersion } = loadScoringRules();
  const store = loadJobStore(storePath || undefined);
  let sourceRows = [];
  let inputPlatform = platform;
  if (fromStore) {
    sourceRows = rowsFromStore(store, { platform });
  } else {
    for (const inputPath of inputPaths) {
      const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
      const records = (payload.records || []).map((row) => ({ ...row, platform: row.platform || payload.platform || platform }));
      sourceRows.push(...records);
      if (!inputPlatform) inputPlatform = payload.platform || platform;
    }
  }
  if (limit > 0) sourceRows = sourceRows.slice(0, limit);

  const deterministic = scoreRecords(sourceRows, { candidate, rules, ruleVersion, candidateVersion, dateKey });
  let rows = deterministic.rows;
  let aiSummary = null;
  if (useAi) {
    const reviewed = await reviewScores(rows, {
      candidate,
      rules,
      ruleVersion,
      candidateVersion,
      maxRows: Number(process.env.AI_SCORE_REVIEW_MAX_ROWS || 8),
      minScore: Number(process.env.AI_SCORE_REVIEW_MIN_SCORE || 50),
    });
    rows = reviewed.rows;
    aiSummary = {
      ok: reviewed.ok,
      skipped: reviewed.skipped,
      selected: reviewed.selected || 0,
      cached: reviewed.cached || 0,
      reviewed: reviewed.reviewed || 0,
      provider: reviewed.provider || "",
      reason: reviewed.reason || "",
    };
  } else {
    rows = rows.map((row) => ({ ...row, score: { ...(row.score || {}), ai: { used: false, status: "disabled", provider: "", model: "", delta: 0, reasons: [], risks: [] } } }));
  }

  const summary = {
    input_rows: sourceRows.length,
    focused: rows.filter((row) => ["重点关注", "可关注"].includes(row.focus_level)).length,
    need_confirm: rows.filter((row) => row.focus_level === "需确认").length,
    hard_fail: rows.filter((row) => row.score?.hard?.status === "fail").length,
    duplicate: rows.filter((row) => row.record_status === "duplicate").length,
    focus_counts: rows.reduce((acc, row) => {
      acc[row.focus_level || ""] = (acc[row.focus_level || ""] || 0) + 1;
      return acc;
    }, {}),
    ai: aiSummary,
    rule_version: ruleVersion,
    candidate_version: candidateVersion,
  };
  const outputs = writeOutputs(inputPlatform || "all", dateKey, rows, summary);
  let updated = 0;
  if (!flag("dry-run")) {
    updated = updateStoreScores(store, rows, { dateKey, ruleVersion, candidateVersion, aiSummary });
    saveJobStore(store, storePath || undefined);
  }
  console.log(JSON.stringify({
    stage: "scored",
    dateKey,
    ...outputs,
    summary,
    updated_store_entries: updated,
    rows: rows.map((row) => ({
      job_store_key: row.job_store_key,
      display_id: row.display_id,
      focus_level: row.focus_level,
      overall: row.overall_fit_score,
      hard: row.score?.hard?.status,
      ai: row.score?.ai?.status,
    })),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { scoreRecords, rowsFromStore, writeOutputs, updateStoreScores, platformOf };
