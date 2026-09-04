const fs = require("fs");
const path = require("path");

const DEFAULT_PLATFORM_PREFIX = {
  BOSS: "A",
  "BOSS直聘": "A",
  liepin: "B",
  Liepin: "B",
  "猎聘": "B",
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadDisplayIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return { version: 1, nextByPrefix: {}, jobsByKey: {}, aliasesByDisplayId: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  return {
    version: parsed.version || 1,
    nextByPrefix: parsed.nextByPrefix || {},
    jobsByKey: parsed.jobsByKey || {},
    aliasesByDisplayId: parsed.aliasesByDisplayId || {},
  };
}

function saveDisplayIndex(indexPath, index) {
  ensureDir(path.dirname(indexPath));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
}

function platformName(row) {
  return row.platform || (row.liepin_job_url ? "猎聘" : "BOSS");
}

function platformPrefix(row) {
  const platform = platformName(row);
  return DEFAULT_PLATFORM_PREFIX[platform] || String(platform || "X").slice(0, 1).toUpperCase() || "X";
}

function padNumber(num) {
  return String(num).padStart(3, "0");
}

function nextDisplayId(index, prefix) {
  const next = Number(index.nextByPrefix[prefix] || 1);
  index.nextByPrefix[prefix] = next + 1;
  return `${prefix}${padNumber(next)}`;
}

function recordKey(row) {
  return `${platformName(row)}:${row.record_key || row.semantic_duplicate_key || row.liepin_job_url || row.boss_job_url || row.job_id || `${row.company || ""}|${row.job_title || ""}|${row.salary || ""}|${row.district || row.city || ""}`}`;
}

function normalizeCompany(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/（.*?）|\(.*?\)/g, "")
    .replace(/有限公司|股份有限公司|有限责任公司|集团|科技|信息|软件|上海|北京|中国|公司/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()\（\）【】\[\]·\-_\s]/g, "")
    .replace(/上海|base上海|急招|高薪/g, "")
    .trim();
}

function normalizedDescription(row) {
  return String(row.job_description || row.page_card_text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。；、,.!?！？:：()（）【】\[\]<>《》"'“”‘’]/g, "");
}

function shingles(text, size = 4) {
  const normalized = String(text || "");
  if (!normalized) return new Set();
  if (normalized.length <= size) return new Set([normalized]);
  const out = new Set();
  for (let i = 0; i <= normalized.length - size; i += 1) out.add(normalized.slice(i, i + size));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function descriptionSimilarity(a, b) {
  const left = normalizedDescription(a);
  const right = normalizedDescription(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return jaccard(shingles(left), shingles(right));
}

function daysBetween(a, b) {
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.abs(left - right) / 86400000;
}

function compactSnapshot(row) {
  return {
    platform: platformName(row),
    record_key: row.record_key || "",
    company: row.company || "",
    normalized_company: normalizeCompany(row.company),
    job_title: row.job_title || "",
    normalized_title: normalizeTitle(row.job_title),
    salary: row.salary || "",
    location: row.district || row.business_area || row.address || row.city || "",
    job_description: normalizedDescription(row).slice(0, 6000),
    job_url: row.liepin_job_url || row.boss_job_url || row.source_url || "",
    source_evaluated_file: row.source_evaluated_file || "",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
}

function similarSuffix(index, baseDisplayId) {
  const used = Object.values(index.jobsByKey || {})
    .map((item) => String(item.display_id || ""))
    .filter((id) => id.startsWith(`${baseDisplayId}-b`))
    .map((id) => Number(id.match(/-b(\d+)$/)?.[1] || 0))
    .filter((num) => num > 0);
  return `${baseDisplayId}-b${Math.max(0, ...used) + 1}`;
}

function findSimilarEntry(index, row, options = {}) {
  const threshold = Number(options.threshold || 0.8);
  const windowDays = Number(options.windowDays || 45);
  const current = compactSnapshot(row);
  if (!current.normalized_company || !current.normalized_title) return null;
  let best = null;
  for (const [key, entry] of Object.entries(index.jobsByKey || {})) {
    if (!entry || key === recordKey(row)) continue;
    const baseEntry = entry.duplicate_of_key ? index.jobsByKey[entry.duplicate_of_key] : entry;
    if (!baseEntry) continue;
    if (baseEntry.normalized_company !== current.normalized_company) continue;
    if (baseEntry.normalized_title !== current.normalized_title) continue;
    if (daysBetween(current.last_seen_at, baseEntry.last_seen_at || baseEntry.first_seen_at) > windowDays) continue;
    const score = descriptionSimilarity(row, baseEntry);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { key: entry.duplicate_of_key || key, entry: baseEntry, score };
  }
  return best;
}

function decorateRecordsWithDisplayIds(records, options = {}) {
  const index = options.index;
  if (!index) throw new Error("decorateRecordsWithDisplayIds requires index");
  for (const row of records) {
    const key = recordKey(row);
    const now = new Date().toISOString();
    const existing = index.jobsByKey[key];
    if (existing) {
      existing.last_seen_at = now;
      existing.salary = row.salary || existing.salary || "";
      existing.location = row.district || row.business_area || row.address || row.city || existing.location || "";
      existing.job_description = normalizedDescription(row).slice(0, 6000) || existing.job_description || "";
      existing.source_evaluated_file = row.source_evaluated_file || existing.source_evaluated_file || "";
      if (existing.duplicate_of_key && index.jobsByKey[existing.duplicate_of_key]?.recommended_at) {
        existing.similar_duplicate_recommended_before = true;
      }
      Object.assign(row, displayFields(existing));
      continue;
    }

    const snapshot = compactSnapshot(row);
    const similar = findSimilarEntry(index, row, options);
    if (similar) {
      snapshot.display_id = similarSuffix(index, similar.entry.display_id);
      snapshot.duplicate_of_key = similar.key;
      snapshot.duplicate_of_display_id = similar.entry.display_id;
      snapshot.similar_score = Number(similar.score.toFixed(3));
      snapshot.similar_duplicate_recommended_before = Boolean(similar.entry.recommended_at);
    } else {
      snapshot.display_id = nextDisplayId(index, platformPrefix(row));
    }
    index.jobsByKey[key] = snapshot;
    index.aliasesByDisplayId[snapshot.display_id] = key;
    Object.assign(row, displayFields(snapshot));
  }
}

function displayFields(entry) {
  return {
    display_id: entry.display_id || "",
    duplicate_of_display_id: entry.duplicate_of_display_id || "",
    similar_score: entry.similar_score || "",
    similar_duplicate: entry.duplicate_of_display_id ? "是" : "否",
    similar_duplicate_recommended_before: entry.similar_duplicate_recommended_before ? "是" : "否",
  };
}

function markRecommended(index, rows) {
  const at = new Date().toISOString();
  for (const row of rows) {
    const key = recordKey(row);
    const entry = index.jobsByKey[key];
    if (!entry) continue;
    entry.recommended_at = entry.recommended_at || at;
    entry.last_recommended_at = at;
  }
}

module.exports = {
  loadDisplayIndex,
  saveDisplayIndex,
  decorateRecordsWithDisplayIds,
  markRecommended,
  recordKey,
};
