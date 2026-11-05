const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { shanghaiDateKey, shanghaiDateTime, daysBetweenDateKeys } = require("../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../core/field_dictionary");
const { readJson, writeJsonAtomic } = require("../core/atomic_json");
const { allocateDisplayId, saveNumbering } = require("./job_numbering");
const { findEarlierCrossChannelDuplicate } = require("./job_duplicates");

const STORE_VERSION = 1;
const DEFAULT_STORE_PATH = path.resolve(__dirname, "..", "..", "data", "job_store.json");

const lifecycleHeaders = [
  "job_store_key",
  "job_status",
  "is_open",
  "closed_at",
  "closed_date",
  "close_reason",
  "status_checked_at",
  "status_check_method",
  "not_seen_refresh_count",
  "missing_since_date",
  "last_missing_at",
  "last_missing_date",
  "first_seen_at",
  "first_seen_date",
  "last_seen_at",
  "last_seen_date",
  "data_updated_at",
  "job_content_updated_at",
  "content_hash",
  "content_changed",
  "changed_fields_json",
  "refresh_time_changed",
  "previous_refresh_time",
  "latest_active_date_changed",
  "previous_latest_active_date",
  "is_pushed",
  "pushed_today",
  "last_pushed_at",
  "last_pushed_date",
  "last_pushed_channel",
  "last_pushed_summary",
  "today_pushed_info_json",
  "pushed_history_json",
  "is_chatting",
  "chat_status",
  "chatting_note",
];

const trackedContentFields = [
  "platform",
  "record_key",
  "platform_job_id",
  "display_id",
  "company",
  "company_industry",
  "company_scale",
  "company_stage",
  "company_summary",
  "job_title",
  "salary",
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
  "recruiter_name",
  "recruiter_title",
  "recruiter_id",
  "recruiter_active_text",
  "boss_name",
  "boss_title",
  "boss_id",
  "boss_active_text",
  "latest_active_date",
  "refresh_time",
  "boss_job_id",
  "job_id",
  "liepin_job_id",
  "boss_job_url",
  "liepin_job_url",
  "source_url",
  "detail_url",
  "job_url",
  "collection_status",
  "detail_status",
  "source_keyword",
  "source_page",
  "ingested_at",
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function defaultStorePath() {
  return process.env.JOB_STORE_PATH || DEFAULT_STORE_PATH;
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    created_at: shanghaiDateTime(),
    updated_at: shanghaiDateTime(),
    jobs: {},
    runs: [],
  };
}

function normalizeStore(parsed) {
  return {
    version: parsed.version || STORE_VERSION,
    created_at: parsed.created_at || shanghaiDateTime(),
    updated_at: parsed.updated_at || "",
    jobs: parsed.jobs || {},
    runs: parsed.runs || [],
  };
}

function loadJobStore(storePath = defaultStorePath()) {
  if (!fs.existsSync(storePath)) return emptyStore();
  const parsed = readJson(storePath, null);
  if (!parsed || typeof parsed !== "object") {
    try { fs.copyFileSync(storePath, `${storePath}.corrupt.${Date.now()}`); } catch { /* best effort */ }
    return emptyStore();
  }
  return normalizeStore(parsed);
}

function saveJobStore(store, storePath = defaultStorePath()) {
  store.version = store.version || STORE_VERSION;
  store.updated_at = shanghaiDateTime();
  writeJsonAtomic(storePath, store, { backup: true });
}

function val(value) {
  if (Array.isArray(value)) return value.join("; ");
  if (value == null) return "";
  return String(value);
}

function csvCell(value) {
  return `"${val(value).replace(/"/g, '""')}"`;
}

function stableValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(stableValue).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\s+/g, " ").trim();
}

function stableObjectHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function platformName(row) {
  return row.platform || (row.liepin_job_url || row.liepin_job_id ? "猎聘" : "BOSS");
}

function platformKey(row) {
  const platform = String(platformName(row)).toLowerCase();
  if (/liepin|猎聘/.test(platform)) return "liepin";
  if (/boss|直聘/.test(platform)) return "boss";
  return platform.replace(/\s+/g, "_") || "unknown";
}

function normalizeFallbackKey(...parts) {
  return parts
    .map((part) => stableValue(part).toLowerCase().replace(/\s+/g, "").replace(/[（）()【】\[\]·\-_/]/g, ""))
    .filter(Boolean)
    .join("|");
}

function jobStoreKey(row) {
  const platform = platformKey(row);
  const recordKey = stableValue(row.record_key);
  if (recordKey) return recordKey.includes(":") ? recordKey : `${platform}:${recordKey}`;
  if (platform === "boss" && (row.job_id || row.boss_job_id)) return `boss:${row.job_id || row.boss_job_id}`;
  if (platform === "liepin" && row.liepin_job_id) return `liepin:${row.liepin_job_id}`;
  const url = stableValue(row.liepin_job_url || row.boss_job_url || row.source_url || row.detail_url);
  const liepinId = url.match(/\/a\/(\d+)\.shtml|job_id=(\d+)/);
  if (liepinId) return `liepin:${liepinId[1] || liepinId[2]}`;
  const bossId = url.match(/\/job_detail\/([^/?#]+)\.html/);
  if (bossId) return `boss:${bossId[1]}`;
  const fallback = normalizeFallbackKey(row.company, row.job_title, row.salary, row.address || row.district || row.city);
  return `${platform}:semantic:${stableObjectHash({ fallback }).slice(0, 16)}`;
}

function jobUrl(row) {
  if (row.liepin_job_id) return `https://www.liepin.com/a/${row.liepin_job_id}.shtml`;
  const liepinUrl = row.liepin_job_url || (row.source_url && String(row.source_url).includes("liepin.com") ? row.source_url : "");
  if (liepinUrl) {
    const id = String(liepinUrl).match(/\/a\/(\d+)\.shtml|job_id=(\d+)/);
    return id ? `https://www.liepin.com/a/${id[1] || id[2]}.shtml` : String(liepinUrl).split("?")[0];
  }
  const bossId = row.job_id || row.boss_job_id;
  if (bossId) return `https://www.zhipin.com/job_detail/${bossId}.html`;
  if (row.boss_job_url) return String(row.boss_job_url).split("?")[0];
  if (row.detail_url && !String(row.detail_url).includes("/wapi/")) return String(row.detail_url).split("?")[0];
  return "";
}

// 岗位事实：只保留“平台上客观存在的信息”，不包含任何评分/推荐判断。
function factsFromRow(row) {
  const platform = platformName(row);
  const platformJobId = stableValue(row.platform_job_id || row.job_id || row.boss_job_id || row.liepin_job_id);
  const facts = {
    platform,
    platform_job_id: platformJobId,
    job_url: jobUrl(row) || stableValue(row.job_url),
    company: stableValue(row.company),
    company_industry: stableValue(row.company_industry),
    company_scale: stableValue(row.company_scale),
    company_stage: stableValue(row.company_stage),
    company_summary: stableValue(row.company_summary),
    job_title: stableValue(row.job_title),
    salary_text: stableValue(row.salary),
    salary_min_k: stableValue(row.salary_min_k),
    salary_max_k: stableValue(row.salary_max_k),
    salary_months: stableValue(row.salary_months),
    city: stableValue(row.city),
    district: stableValue(row.district),
    business_area: stableValue(row.business_area),
    address: stableValue(row.address || row.business_area || row.city),
    experience: stableValue(row.experience),
    degree: stableValue(row.degree),
    tags: stableValue(row.tags),
    skills: stableValue(row.skills),
    job_description: stableValue(row.job_description),
    boss_active_text: stableValue(row.boss_active_text),
    recruiter_active_text: stableValue(row.recruiter_active_text),
    latest_active_date: stableValue(row.latest_active_date),
    boss_online: row.boss_online === true || row.boss_online === "true",
    detail_status: stableValue(row.detail_status || row.collection_status),
    collected_at: stableValue(row.collected_at),
    source_keyword: stableValue(row.source_keyword || row.keyword),
    source_page: stableValue(row.source_page || row.page),
    refresh_time: stableValue(row.refresh_time),
    tags_json: JSON.stringify(Array.isArray(row.tags) ? row.tags : []),
  };
  // 内容指纹只看“岗位事实是否变化”，不看采集时间/来源关键词/页码，避免同一岗位每天重采就被判成内容变化。
  const hashPayload = { ...facts };
  delete hashPayload.collected_at;
  delete hashPayload.source_keyword;
  delete hashPayload.source_page;
  delete hashPayload.content_hash;
  facts.content_hash = stableObjectHash(hashPayload);
  return facts;
}

function enrichRowWithFacts(row, facts, extra = {}) {
  return {
    ...row,
    ...facts,
    salary: facts.salary_text,
    job_url: facts.job_url,
    ...extra,
  };
}

function createEntry(key, row, snapshot, hash, options) {
  const now = options.now || shanghaiDateTime();
  const dateKey = options.dateKey || shanghaiDateKey();
  const facts = options.facts || factsFromRow(row);
  return {
    job_store_key: key,
    platform: snapshot.platform,
    record_key: stableValue(row.record_key),
    platform_job_id: facts.platform_job_id,
    display_id: options.displayId || stableValue(row.display_id),
    facts,
    record_status: options.recordStatus || "active",
    duplicate_of_key: options.duplicateOfKey || "",
    duplicate_of_display_id: options.duplicateOfDisplayId || "",
    duplicate_score: options.duplicateScore || 0,
    ingested_at: options.ingestedAt || now,
    score: options.score || null,
    company: stableValue(row.company),
    job_title: stableValue(row.job_title),
    salary: stableValue(row.salary),
    city: stableValue(row.city),
    district: stableValue(row.district),
    address: stableValue(row.address || row.business_area || row.city),
    job_url: snapshot.job_url,
    first_seen_at: now,
    first_seen_date: dateKey,
    last_seen_at: now,
    last_seen_date: dateKey,
    status_checked_at: now,
    status_check_method: "current_collection",
    job_status: "open",
    is_open: "是",
    closed_at: "",
    closed_date: "",
    close_reason: "",
    not_seen_refresh_count: 0,
    missing_since_date: "",
    last_missing_at: "",
    last_missing_date: "",
    data_updated_at: now,
    job_content_updated_at: now,
    content_hash: hash,
    content_snapshot: snapshot,
    content_changed: "是",
    changed_fields: Object.keys(snapshot),
    refresh_time: stableValue(row.refresh_time),
    previous_refresh_time: "",
    refresh_time_changed: "否",
    latest_active_date: stableValue(row.latest_active_date),
    previous_latest_active_date: "",
    latest_active_date_changed: "否",
    is_pushed: "否",
    last_pushed_at: "",
    last_pushed_date: "",
    last_pushed_channel: "",
    last_pushed_summary: "",
    pushed_history: [],
    is_chatting: stableValue(row.is_chatting) || "否",
    chat_status: stableValue(row.chat_status) || "未沟通",
    chatting_note: stableValue(row.chatting_note),
  };
}

function snapshotFromRow(row) {
  const facts = row.facts || null;
  const out = {};
  for (const field of trackedContentFields) {
    let value = row[field];
    if ((value === undefined || value === null || value === "") && facts) {
      value = field === "salary" ? facts.salary_text : facts[field];
    }
    if (value !== undefined && value !== null && value !== "") out[field] = stableValue(value);
  }
  out.platform = platformName(row);
  out.job_url = jobUrl(row) || stableValue(facts?.job_url || row.job_url);
  return out;
}

// 入库：只校验“数据完整性 + 去重”，不做任何好坏判断。
// 被调用方保证行里已经有平台唯一 ID 和完整 JD；这里再兜底检查一次。
function ingestFacts(store, row, options = {}) {
  const now = options.now || shanghaiDateTime();
  const dateKey = options.dateKey || shanghaiDateKey();
  const key = jobStoreKey(row);
  const facts = factsFromRow(row);
  if (!facts.platform_job_id || !facts.job_description || facts.job_description.trim().length < (options.minJdLength || 40)) {
    return { key, isNew: false, accepted: false, reason: "missing_platform_id_or_full_jd", facts };
  }
  const existing = store.jobs[key];
  if (existing) {
    const merged = enrichRowWithFacts(row, facts, { display_id: existing.display_id });
    const snapshot = snapshotFromRow(merged);
    const hash = stableObjectHash(snapshot);
    const changed = existing.content_hash !== hash;
    const contentFieldChanges = changed ? changedFields(existing.content_snapshot, snapshot) : [];
    if (changed) {
      existing.content_hash = hash;
      existing.content_snapshot = snapshot;
      existing.content_changed = "是";
      existing.changed_fields = contentFieldChanges;
      existing.job_content_updated_at = now;
    } else {
      existing.content_changed = "否";
      existing.changed_fields = [];
    }
    existing.facts = facts;
    existing.content_snapshot = snapshot;
    existing.record_key = stableValue(row.record_key || existing.record_key);
    existing.company = facts.company;
    existing.job_title = facts.job_title;
    existing.salary = facts.salary_text;
    existing.city = facts.city;
    existing.district = facts.district;
    existing.address = facts.address;
    existing.job_url = facts.job_url;
    existing.last_seen_at = now;
    existing.last_seen_date = dateKey;
    existing.status_checked_at = now;
    existing.job_status = "open";
    existing.is_open = "是";
    existing.close_reason = "";
    existing.missing_since_date = "";
    existing.last_missing_at = "";
    existing.last_missing_date = "";
    existing.not_seen_refresh_count = 0;
    existing.data_updated_at = now;
    return { key, accepted: true, isNew: false, changed, displayId: existing.display_id, recordStatus: existing.record_status || "active", facts };
  }

  const numberingState = options.numberingState || null;
  const allocation = allocateDisplayId(store, facts.platform, options.numberingPath, numberingState);
  const enriched = enrichRowWithFacts(row, facts, { display_id: allocation.displayId });
  const snapshot = snapshotFromRow(enriched);
  const hash = stableObjectHash(snapshot);
  const duplicate = findEarlierCrossChannelDuplicate(store, enriched, {
    threshold: options.duplicateThreshold || 0.8,
    currentKey: key,
  });
  const entry = createEntry(key, enriched, snapshot, hash, {
    now,
    dateKey,
    facts,
    displayId: allocation.displayId,
    ingestedAt: now,
    recordStatus: duplicate ? "duplicate" : "active",
    duplicateOfKey: duplicate?.key || "",
    duplicateOfDisplayId: duplicate?.entry?.display_id || "",
    duplicateScore: duplicate?.score || 0,
  });
  store.jobs[key] = entry;
  return {
    key,
    accepted: true,
    isNew: true,
    changed: true,
    displayId: allocation.displayId,
    recordStatus: entry.record_status,
    duplicateOfDisplayId: entry.duplicate_of_display_id,
    facts,
    numbering: allocation.numbering,
  };
}

function changedFields(previousSnapshot, nextSnapshot) {
  const keys = new Set([...Object.keys(previousSnapshot || {}), ...Object.keys(nextSnapshot || {})]);
  const changed = [];
  for (const key of keys) {
    if (stableValue(previousSnapshot?.[key]) !== stableValue(nextSnapshot?.[key])) changed.push(key);
  }
  return changed;
}

function setIfChanged(entry, field, value, changes) {
  const next = stableValue(value);
  if (stableValue(entry[field]) === next) return;
  entry[field] = next;
  changes.push(field);
}

function upsertRecord(store, row, options = {}) {
  const now = options.now || shanghaiDateTime();
  const dateKey = options.dateKey || shanghaiDateKey();
  const key = jobStoreKey(row);
  const snapshot = snapshotFromRow(row);
  const hash = stableObjectHash(snapshot);
  const existing = store.jobs[key];
  if (!existing) {
    const entry = createEntry(key, row, snapshot, hash, { now, dateKey });
    store.jobs[key] = entry;
    return { key, isNew: true, changed: true, changedFields: entry.changed_fields };
  }

  const changes = [];
  const contentChanged = existing.content_hash !== hash;
  const contentFieldChanges = contentChanged ? changedFields(existing.content_snapshot, snapshot) : [];
  if (contentChanged) {
    existing.content_hash = hash;
    existing.content_snapshot = snapshot;
    existing.job_content_updated_at = now;
    existing.content_changed = "是";
    existing.changed_fields = contentFieldChanges;
    changes.push("content_hash", "content_snapshot", "job_content_updated_at", "changed_fields");
  } else {
    existing.content_changed = "否";
    existing.changed_fields = [];
  }

  const previousRefresh = stableValue(existing.refresh_time);
  const nextRefresh = stableValue(row.refresh_time);
  if (nextRefresh && previousRefresh && nextRefresh !== previousRefresh) {
    existing.previous_refresh_time = previousRefresh;
    existing.refresh_time_changed = "是";
    existing.last_refresh_change_at = now;
    changes.push("previous_refresh_time", "refresh_time_changed", "last_refresh_change_at");
  } else {
    existing.refresh_time_changed = "否";
  }
  if (nextRefresh) setIfChanged(existing, "refresh_time", nextRefresh, changes);

  const previousActive = stableValue(existing.latest_active_date);
  const nextActive = stableValue(row.latest_active_date);
  if (nextActive && previousActive && nextActive !== previousActive) {
    existing.previous_latest_active_date = previousActive;
    existing.latest_active_date_changed = "是";
    changes.push("previous_latest_active_date", "latest_active_date_changed");
  } else {
    existing.latest_active_date_changed = "否";
  }
  if (nextActive) setIfChanged(existing, "latest_active_date", nextActive, changes);

  const visibleFields = {
    platform: snapshot.platform,
    record_key: row.record_key,
    display_id: row.display_id,
    company: row.company,
    job_title: row.job_title,
    salary: row.salary,
    city: row.city,
    district: row.district,
    address: row.address || row.business_area || row.city,
    job_url: snapshot.job_url,
  };
  for (const [field, value] of Object.entries(visibleFields)) {
    if (value !== undefined && value !== null && value !== "") setIfChanged(existing, field, value, changes);
  }

  setIfChanged(existing, "last_seen_at", now, changes);
  setIfChanged(existing, "last_seen_date", dateKey, changes);
  setIfChanged(existing, "status_checked_at", now, changes);
  setIfChanged(existing, "status_check_method", "current_collection", changes);
  setIfChanged(existing, "job_status", "open", changes);
  setIfChanged(existing, "is_open", "是", changes);
  setIfChanged(existing, "close_reason", "", changes);
  setIfChanged(existing, "missing_since_date", "", changes);
  setIfChanged(existing, "last_missing_at", "", changes);
  setIfChanged(existing, "last_missing_date", "", changes);
  if (Number(existing.not_seen_refresh_count || 0) !== 0) {
    existing.not_seen_refresh_count = 0;
    changes.push("not_seen_refresh_count");
  }

  if (!existing.is_chatting) existing.is_chatting = "否";
  if (!existing.chat_status) existing.chat_status = "未沟通";
  if (!Array.isArray(existing.pushed_history)) existing.pushed_history = [];
  if (changes.length) existing.data_updated_at = now;
  return { key, isNew: false, changed: changes.length > 0, changedFields: [...new Set([...changes, ...contentFieldChanges])] };
}

function todayPushHistory(entry, dateKey) {
  return (entry.pushed_history || []).filter((item) => item.dateKey === dateKey);
}

function lifecycleFields(entry, dateKey = shanghaiDateKey()) {
  const todayHistory = todayPushHistory(entry, dateKey);
  return {
    job_store_key: entry.job_store_key || "",
    job_status: entry.job_status || "",
    is_open: entry.is_open || "",
    closed_at: entry.closed_at || "",
    closed_date: entry.closed_date || "",
    close_reason: entry.close_reason || "",
    status_checked_at: entry.status_checked_at || "",
    status_check_method: entry.status_check_method || "",
    not_seen_refresh_count: entry.not_seen_refresh_count || 0,
    missing_since_date: entry.missing_since_date || "",
    last_missing_at: entry.last_missing_at || "",
    last_missing_date: entry.last_missing_date || "",
    first_seen_at: entry.first_seen_at || "",
    first_seen_date: entry.first_seen_date || "",
    last_seen_at: entry.last_seen_at || "",
    last_seen_date: entry.last_seen_date || "",
    data_updated_at: entry.data_updated_at || "",
    job_content_updated_at: entry.job_content_updated_at || "",
    content_hash: entry.content_hash || "",
    content_changed: entry.content_changed || "否",
    changed_fields_json: JSON.stringify(entry.changed_fields || []),
    refresh_time_changed: entry.refresh_time_changed || "否",
    previous_refresh_time: entry.previous_refresh_time || "",
    latest_active_date_changed: entry.latest_active_date_changed || "否",
    previous_latest_active_date: entry.previous_latest_active_date || "",
    is_pushed: entry.is_pushed || "否",
    pushed_today: todayHistory.some((item) => item.delivered) ? "是" : "否",
    last_pushed_at: entry.last_pushed_at || "",
    last_pushed_date: entry.last_pushed_date || "",
    last_pushed_channel: entry.last_pushed_channel || "",
    last_pushed_summary: entry.last_pushed_summary || "",
    today_pushed_info_json: JSON.stringify(todayHistory),
    pushed_history_json: JSON.stringify(entry.pushed_history || []),
    is_chatting: entry.is_chatting || "否",
    chat_status: entry.chat_status || "未沟通",
    chatting_note: entry.chatting_note || "",
  };
}

function decorateRowsWithStore(store, rows, options = {}) {
  const dateKey = options.dateKey || shanghaiDateKey();
  return rows.map((row) => {
    const key = jobStoreKey(row);
    const entry = store.jobs[key];
    return {
      ...row,
      ...lifecycleFields(entry || { job_store_key: key }, dateKey),
      job_store_key: key,
      display_id: entry?.display_id || row.display_id || "",
      record_status: entry?.record_status || row.record_status || "active",
      duplicate_of_display_id: entry?.duplicate_of_display_id || "",
      facts: entry?.facts || row.facts || null,
      score: entry?.score || row.score || null,
    };
  });
}

function orderedHeaders(records) {
  const headers = [];
  for (const header of lifecycleHeaders) headers.push(header);
  for (const row of records) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return headers;
}

function writeCsv(csvPath, records) {
  const headers = orderedHeaders(records);
  const lines = [
    headers.map((header) => csvCell(fieldZh[header] || header)).join(","),
    headers.map(csvCell).join(","),
    headers.map((header) => csvCell(fieldDescriptions[header] || "")).join(","),
    ...records.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  ensureDir(path.dirname(csvPath));
  fs.writeFileSync(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");
}

function inferPlatform(payload, inputPath) {
  if (payload.platform) return payload.platform;
  const first = (payload.records || [])[0] || {};
  if (first.platform) return first.platform;
  const name = path.basename(inputPath).toLowerCase();
  if (name.includes("liepin")) return "猎聘";
  return "BOSS";
}

function outputPrefix(platform) {
  return /猎聘|liepin/i.test(platform) ? "liepin_stage4_tracked" : "boss_stage4_tracked";
}

function writeTrackedOutput(store, inputPath, options = {}) {
  const dateKey = options.dateKey || shanghaiDateKey();
  const outputsDir = options.outputsDir || path.resolve(__dirname, "..", "..", "outputs");
  const stamp = options.stamp || new Date().toISOString().replace(/[:.]/g, "-");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const platform = inferPlatform(payload, inputPath);
  const records = decorateRowsWithStore(store, payload.records || [], { dateKey }).map((row) => ({
    platform,
    ...row,
  }));
  const prefix = outputPrefix(platform);
  const jsonPath = path.join(outputsDir, `${prefix}_${stamp}.json`);
  const csvPath = path.join(outputsDir, `${prefix}_${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ ...payload, platform, records, job_store_updated_at: shanghaiDateTime() }, null, 2), "utf8");
  writeCsv(csvPath, records);
  return { platform, inputPath, jsonPath, csvPath, recordCount: records.length };
}

function upsertRecords(store, records, options = {}) {
  const currentKeys = [];
  const newKeys = [];
  const changedKeys = [];
  for (const row of records || []) {
    const result = upsertRecord(store, row, options);
    currentKeys.push(result.key);
    if (result.isNew) newKeys.push(result.key);
    if (result.changed) changedKeys.push(result.key);
  }
  return {
    currentKeys: [...new Set(currentKeys)],
    newKeys: [...new Set(newKeys)],
    changedKeys: [...new Set(changedKeys)],
  };
}

function upsertEvaluatedFiles(store, inputPaths, options = {}) {
  const totals = { currentKeys: [], newKeys: [], changedKeys: [], trackedFiles: [], inputFiles: [] };
  const stamp = options.stamp || new Date().toISOString().replace(/[:.]/g, "-");
  for (const inputPath of inputPaths) {
    const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const platform = inferPlatform(payload, inputPath);
    const result = upsertRecords(store, payload.records || [], options);
    totals.currentKeys.push(...result.currentKeys);
    totals.newKeys.push(...result.newKeys);
    totals.changedKeys.push(...result.changedKeys);
    totals.inputFiles.push({ platform, inputPath, recordCount: (payload.records || []).length });
    totals.trackedFiles.push(writeTrackedOutput(store, inputPath, { ...options, stamp }));
  }
  totals.currentKeys = [...new Set(totals.currentKeys)];
  totals.newKeys = [...new Set(totals.newKeys)];
  totals.changedKeys = [...new Set(totals.changedKeys)];
  store.runs = store.runs || [];
  store.runs.push({
    at: options.now || shanghaiDateTime(),
    dateKey: options.dateKey || shanghaiDateKey(),
    action: "upsert_evaluated_files",
    inputFiles: totals.inputFiles,
    currentCount: totals.currentKeys.length,
    newCount: totals.newKeys.length,
    changedCount: totals.changedKeys.length,
  });
  store.runs = store.runs.slice(-200);
  return totals;
}

function markPushedItems(store, items, options = {}) {
  const now = options.now || shanghaiDateTime();
  const dateKey = options.dateKey || shanghaiDateKey();
  const changedKeys = [];
  for (const item of items || []) {
    const key = item.job_store_key || jobStoreKey(item);
    if (!store.jobs[key]) {
      store.jobs[key] = createEntry(key, item, snapshotFromRow(item), stableObjectHash(snapshotFromRow(item)), { now, dateKey });
    }
    const entry = store.jobs[key];
    const summary = item.push_summary || `${item.platform || entry.platform || ""} ${item.company || entry.company || ""} ${item.job_title || entry.job_title || ""} ${item.salary || entry.salary || ""}`.replace(/\s+/g, " ").trim();
    const historyItem = {
      dateKey,
      at: now,
      channelName: options.channelName || item.channelName || "",
      draftHash: options.draftHash || item.draftHash || "",
      sendMode: options.sendMode || "",
      delivered: Boolean(options.delivered),
      display_id: item.display_id || entry.display_id || "",
      platform: item.platform || entry.platform || "",
      company: item.company || entry.company || "",
      job_title: item.job_title || entry.job_title || "",
      salary: item.salary || entry.salary || "",
      location: item.location || entry.district || entry.address || "",
      active_text: item.active_text || "",
      match_point: item.match_point || "",
      link: item.link || entry.job_url || "",
      message_text: item.message_text || "",
      push_summary: summary,
    };
    entry.pushed_history = entry.pushed_history || [];
    const dup = entry.pushed_history.some((old) => old.dateKey === historyItem.dateKey && old.draftHash === historyItem.draftHash && old.message_text === historyItem.message_text);
    if (!dup) entry.pushed_history.push(historyItem);
    entry.pushed_history = entry.pushed_history.slice(-80);
    if (options.delivered) {
      entry.is_pushed = "是";
      entry.last_pushed_at = now;
      entry.last_pushed_date = dateKey;
      entry.last_pushed_channel = historyItem.channelName;
      entry.last_pushed_summary = summary;
    }
    if (item.display_id && entry.display_id !== item.display_id) entry.display_id = item.display_id;
    entry.data_updated_at = now;
    changedKeys.push(key);
  }
  if ((items || []).length) {
    store.runs = store.runs || [];
    store.runs.push({
      at: now,
      dateKey,
      action: "mark_pushed_items",
      channelName: options.channelName || "",
      delivered: Boolean(options.delivered),
      count: items.length,
    });
    store.runs = store.runs.slice(-200);
  }
  return { changedKeys: [...new Set(changedKeys)], count: changedKeys.length };
}

function refreshMissingOpenJobs(store, currentKeys, options = {}) {
  const now = options.now || shanghaiDateTime();
  const dateKey = options.dateKey || shanghaiDateKey();
  const closeAfterDays = Number(options.closeAfterDays ?? process.env.JOB_CLOSE_AFTER_MISSING_DAYS ?? 0);
  const current = new Set(currentKeys || []);
  const allowedPlatforms = new Set((options.platforms || []).map((value) => platformKey({ platform: value })));
  const changed = [];
  const closed = [];
  const unknown = [];
  for (const [key, entry] of Object.entries(store.jobs || {})) {
    if (allowedPlatforms.size && !allowedPlatforms.has(platformKey(entry))) continue;
    if (entry.record_status === "duplicate") continue; // 重复记录不参与“是否关闭”的主记录判断
    if (current.has(key)) {
      // 本轮列表里实际看到了它：刷新 last_seen，并把它从 missing/unknown/closed 恢复为 open。
      const previousStatus = entry.job_status || "open";
      entry.last_seen_at = now;
      entry.last_seen_date = dateKey;
      entry.status_checked_at = now;
      entry.status_check_method = "latest_collection_seen";
      entry.missing_since_date = "";
      entry.last_missing_at = "";
      entry.last_missing_date = "";
      entry.not_seen_refresh_count = 0;
      entry.job_status = "open";
      entry.is_open = "是";
      entry.close_reason = "";
      entry.closed_at = "";
      entry.closed_date = "";
      entry.data_updated_at = now;
      if (previousStatus !== "open") changed.push({ key, previousStatus, nextStatus: "open", missingDays: 0 });
      continue;
    }
    if (entry.job_status === "closed") continue;
    if (entry.first_seen_date === dateKey) continue;
    if (entry.last_seen_date === dateKey) continue;

    const previousStatus = entry.job_status || "open";
    entry.status_checked_at = now;
    entry.status_check_method = "latest_collection_presence";
    if (!entry.missing_since_date) entry.missing_since_date = dateKey;
    entry.last_missing_at = now;
    if (entry.last_missing_date !== dateKey) {
      entry.not_seen_refresh_count = Number(entry.not_seen_refresh_count || 0) + 1;
    }
    entry.last_missing_date = dateKey;
    const missingDays = Math.max(1, (daysBetweenDateKeys(entry.missing_since_date, dateKey) ?? 0) + 1);
    if (closeAfterDays > 0 && missingDays >= closeAfterDays) {
      entry.job_status = "closed";
      entry.is_open = "否";
      entry.closed_at = entry.closed_at || now;
      entry.closed_date = entry.closed_date || dateKey;
      entry.close_reason = `连续 ${missingDays} 天未在每日刷新结果中出现，按配置判断为关闭或不可继续跟进`;
      closed.push(key);
    } else {
      entry.job_status = "unknown";
      entry.is_open = "未知";
      entry.close_reason = closeAfterDays > 0
        ? `未在本轮刷新结果中出现，等待后续刷新确认；连续 ${closeAfterDays} 天缺失后才标记关闭`
        : "未在本轮刷新结果中出现；自动关闭未启用，需人工复核是否仍开放";
      unknown.push(key);
    }
    entry.data_updated_at = now;
    changed.push({ key, previousStatus, nextStatus: entry.job_status, missingDays });
  }
  store.runs = store.runs || [];
  store.runs.push({
    at: now,
    dateKey,
    action: "refresh_missing_open_jobs",
    method: "latest_collection_presence",
    currentCount: current.size,
    changedCount: changed.length,
    unknownCount: unknown.length,
    closedCount: closed.length,
    closeAfterDays,
    platforms: [...allowedPlatforms],
  });
  store.runs = store.runs.slice(-200);
  return { changed, unknown, closed, closeAfterDays, platforms: [...allowedPlatforms] };
}

function storeRecords(store, dateKey = shanghaiDateKey()) {
  return Object.values(store.jobs || {}).map((entry) => ({
    ...lifecycleFields(entry, dateKey),
    platform: entry.platform || "",
    display_id: entry.display_id || "",
    record_status: entry.record_status || "active",
    duplicate_of_display_id: entry.duplicate_of_display_id || "",
    job_store_key: entry.job_store_key || "",
    record_key: entry.record_key || "",
    company: entry.company || "",
    job_title: entry.job_title || "",
    salary: entry.salary || "",
    city: entry.city || "",
    district: entry.district || "",
    address: entry.address || "",
    job_url: entry.job_url || "",
    latest_active_date: entry.latest_active_date || "",
    refresh_time: entry.refresh_time || "",
  }));
}

function writeStoreSnapshot(store, options = {}) {
  const outputsDir = options.outputsDir || path.resolve(__dirname, "..", "..", "outputs");
  const dateKey = options.dateKey || shanghaiDateKey();
  const stamp = options.stamp || new Date().toISOString().replace(/[:.]/g, "-");
  const records = storeRecords(store, dateKey);
  const jsonPath = path.join(outputsDir, `job_store_snapshot_${stamp}.json`);
  const csvPath = path.join(outputsDir, `job_store_snapshot_${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ version: store.version, dateKey, records }, null, 2), "utf8");
  writeCsv(csvPath, records);
  return { jsonPath, csvPath, recordCount: records.length };
}

module.exports = {
  defaultStorePath,
  loadJobStore,
  saveJobStore,
  jobStoreKey,
  platformKey,
  jobUrl,
  platformName,
  factsFromRow,
  enrichRowWithFacts,
  ingestFacts,
  lifecycleFields,
  decorateRowsWithStore,
  upsertRecords,
  upsertEvaluatedFiles,
  markPushedItems,
  refreshMissingOpenJobs,
  writeTrackedOutput,
  writeStoreSnapshot,
};
