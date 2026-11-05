const path = require("path");
const { readJson, writeJsonAtomic } = require("../core/atomic_json");

const rootDir = path.resolve(__dirname, "..", "..");
const DEFAULT_NUMBERING_PATH = path.join(rootDir, "data", "job_numbering.json");

const PLATFORM_PREFIX = {
  boss: "A",
  BOSS: "A",
  BOSS直聘: "A",
  liepin: "B",
  Liepin: "B",
  猎聘: "B",
};

function platformPrefix(platform) {
  const key = String(platform || "").trim();
  return PLATFORM_PREFIX[key] || PLATFORM_PREFIX[key.toLowerCase()] || key.slice(0, 1).toUpperCase() || "X";
}

function formatDisplayId(prefix, number) {
  return `${prefix}${String(number).padStart(3, "0")}`;
}

function parseDisplayNumber(displayId, prefix) {
  const match = String(displayId || "").match(new RegExp(`^${prefix}(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

function loadNumbering(filePath = DEFAULT_NUMBERING_PATH) {
  const state = readJson(filePath, null);
  return {
    version: 1,
    counters: (state && state.counters) || {},
  };
}

function saveNumbering(state, filePath = DEFAULT_NUMBERING_PATH) {
  writeJsonAtomic(filePath, { version: 1, updated_at: new Date().toISOString(), counters: state.counters || {} }, { backup: true });
}

// 编号在“真正写入岗位库”时分配。为了满足“写入成功才占号、不回收、不重排”，
// 这里同时扫描岗位库已有编号，取 max(计数器, 库内最大号) 再 +1；
// 即使上次写库成功但计数器没来得及落盘，也不会发出重复编号。
function allocateDisplayId(store, platform, filePath = DEFAULT_NUMBERING_PATH, state = null) {
  const prefix = platformPrefix(platform);
  const numbering = state || loadNumbering(filePath);
  let maxInStore = 0;
  for (const entry of Object.values((store && store.jobs) || {})) {
    if (!entry || !entry.display_id) continue;
    maxInStore = Math.max(maxInStore, parseDisplayNumber(entry.display_id, prefix));
  }
  const current = Number(numbering.counters[prefix] || 0);
  const next = Math.max(current, maxInStore, 0) + 1;
  numbering.counters[prefix] = next;
  return {
    displayId: formatDisplayId(prefix, next),
    numbering,
    prefix,
    number: next,
  };
}

module.exports = {
  DEFAULT_NUMBERING_PATH,
  platformPrefix,
  formatDisplayId,
  parseDisplayNumber,
  loadNumbering,
  saveNumbering,
  allocateDisplayId,
};
