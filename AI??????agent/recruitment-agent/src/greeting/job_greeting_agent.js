const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../core/load_env");
const { recommendGreetingResult } = require("./greeting_recommender");
const { loadDisplayIndex, recordKey } = require("../push/job_display_index");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const displayIndexPath = path.join(rootDir, "data", "job_display_index.json");

function locationOf(row) {
  return row.district || row.business_area || row.address || row.city || row.location || "地点未知";
}

function extractJobFieldsFromText(jobText) {
  const text = String(jobText || "");
  const titleMatch = text.match(/【([^】]+)】\s*([^｜\n]+)｜([^｜\n]+)｜([^\n]+?)(?:\s*(?:岗位要求|职位详情|JD|职责|要求)[:：]|$)/i);
  if (!titleMatch) return {};
  const companyAndTitle = titleMatch[2].trim().split(/\s+-\s+/);
  return {
    platform: titleMatch[1].trim(),
    company: companyAndTitle[0] || "",
    job_title: companyAndTitle.slice(1).join(" - ") || "",
    salary: titleMatch[3].trim(),
    location: titleMatch[4].trim(),
    job_description: text,
    page_card_text: text
  };
}

function loadLatestRecord(entry, key) {
  let sourcePath = entry.source_evaluated_file;
  if (sourcePath && !fs.existsSync(sourcePath)) {
    // Historical indexes can retain the pre-migration absolute directory.
    // Resolve by filename inside this agent's current outputs directory.
    const relocated = path.join(rootDir, "outputs", path.basename(sourcePath));
    if (fs.existsSync(relocated)) sourcePath = relocated;
  }
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const payload = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  return (payload.records || []).find((row) => {
    const platform = payload.platform || row.platform || (row.liepin_job_url ? "猎聘" : "BOSS");
    return recordKey({ platform, ...row }) === key;
  }) || null;
}

function resolveJobByDisplayId(displayId, options = {}) {
  const id = String(displayId || "").trim();
  if (!id) throw new Error("display_id is required");
  const index = loadDisplayIndex(options.displayIndexPath || displayIndexPath);
  const key = index.aliasesByDisplayId?.[id];
  if (!key || !index.jobsByKey[key]) throw new Error(`Display id not found: ${id}`);
  const entry = index.jobsByKey[key];
  const latest = loadLatestRecord(entry, key);
  return {
    ...entry,
    ...(latest || {}),
    platform: entry.platform,
    display_id: entry.display_id,
  };
}

function requestToJob(request) {
  const normalized = typeof request === "string" ? { job_text: request } : (request || {});
  const jobText = normalized.job_text || normalized.jobText || normalized.image_ocr_text || normalized.ocr_text || normalized.text || "";
  const inferredId = String(jobText).toUpperCase().match(/\b([AB]\d{3})\b/)?.[1] || "";
  const displayId = normalized.display_id || normalized.displayId || normalized.job_id_display || inferredId;
  const topLevelJob = {};
  for (const key of ["platform", "company", "job_title", "salary", "city", "district", "business_area", "address", "experience", "degree", "tags", "job_description", "page_card_text"]) {
    if (normalized[key] !== undefined) topLevelJob[key] = normalized[key];
  }
  const suppliedJob = { ...topLevelJob, ...(normalized.job && typeof normalized.job === "object" ? normalized.job : {}) };
  let row = displayId ? resolveJobByDisplayId(displayId) : {};
  row = { ...row, ...suppliedJob };
  if (normalized.platform && !row.platform) row.platform = normalized.platform;
  if (jobText) {
    row = { ...extractJobFieldsFromText(jobText), ...row };
    row.job_description = row.job_description || String(jobText);
    row.page_card_text = row.page_card_text || String(jobText);
  }
  if (!displayId && !Object.keys(suppliedJob).length && !jobText) {
    throw new Error("Provide display_id, job, or job_text/image_ocr_text");
  }
  return { row, inputType: displayId ? "display_id" : (jobText ? "job_text" : "job") };
}

async function createGreetingResponse(request, options = {}) {
  const normalized = typeof request === "string" ? { job_text: request } : (request || {});
  const { row, inputType } = requestToJob(normalized);
  const greeting = await recommendGreetingResult(row, {
    mode: normalized.greeting_mode || normalized.greetingMode || options.mode,
    maxLength: normalized.max_length || normalized.maxLength || options.maxLength,
  });
  return {
    input_type: inputType,
    resolved_from_index: inputType === "display_id",
    display_id: row.display_id || "",
    platform: row.platform || "",
    company: row.company || "",
    job_title: row.job_title || "",
    salary: row.salary || "",
    location: locationOf(row),
    duplicate_of_display_id: row.duplicate_of_display_id || "",
    greeting_message: greeting.message,
    greeting_strategy: greeting.strategy,
    greeting_basis: greeting.basis,
  };
}

function formatGreetingText(result) {
  const id = result.display_id ? `${result.display_id} ` : "";
  const jobLine = `${id}【${result.platform || "岗位信息"}】${result.company || "未知公司"} - ${result.job_title || "未知岗位"}｜${result.salary || "薪资未知"}｜${result.location}`;
  return `${jobLine}\n打招呼：${result.greeting_message}`;
}

function usage() {
  console.error("Usage: node src/greeting/job_greeting_agent.js --id A001 [--json]");
  console.error("   or: node src/greeting/job_greeting_agent.js --input request.json [--json]");
  console.error("   or: node src/greeting/job_greeting_agent.js --job-text \"OCR extracted job text\" [--json]");
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const asJson = process.argv.includes("--json");
  const inputPath = argValue("--input");
  const positionalId = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  const displayId = argValue("--id") || positionalId;
  const jobText = argValue("--job-text");
  let request;
  if (inputPath) request = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), inputPath), "utf8"));
  else if (jobText) request = { job_text: jobText };
  else if (displayId) request = { display_id: displayId };
  else {
    usage();
    process.exitCode = 1;
    return;
  }
  const result = await createGreetingResponse(request);
  console.log(asJson ? JSON.stringify(result, null, 2) : formatGreetingText(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { createGreetingResponse, formatGreetingText, resolveJobByDisplayId, extractJobFieldsFromText };
