const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("../core/atomic_json");

const rootDir = path.resolve(__dirname, "..", "..");
const ledgerDir = path.join(rootDir, "data", "collection_ledger");
const outputsDir = path.join(rootDir, "outputs");

function ledgerPath(dateKey) {
  return path.join(ledgerDir, `${dateKey}.jsonl`);
}

function appendLedgerEntries(dateKey, entries) {
  if (!entries || !entries.length) return [];
  fs.mkdirSync(ledgerDir, { recursive: true });
  const lines = entries.map((entry) => JSON.stringify({ date: dateKey, ...entry })).join("\n");
  fs.appendFileSync(ledgerPath(dateKey), `${lines}\n`, "utf8");
  return entries;
}

function readLedger(dateKey) {
  const filePath = ledgerPath(dateKey);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readRecentLedger(days = 30, now = new Date()) {
  const entries = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(now.getTime() - offset * 86400000);
    const dateKey = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    entries.push(...readLedger(dateKey));
  }
  return entries;
}

const SUM_FIELDS = [
  "seen", "duplicates", "new_candidates", "detail_attempts", "detail_ok", "detail_fail",
  "pending", "ingested_primary", "ingested_duplicate", "pending_confirmed", "updated_existing",
  "page_errors", "elapsed_ms",
];

function mergeDay(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const channel = entry.channel || "未知渠道";
    const keyword = entry.keyword || "未标注关键词";
    const key = `${channel}|${keyword}`;
    if (!map.has(key)) {
      map.set(key, {
        date: entry.date || "",
        channel,
        keyword,
        target_new: 0,
        pages: 0,
        stop_reason: "",
        errors: [],
        match_score: null,
        is_new_keyword: false,
        priority: null,
      });
    }
    const item = map.get(key);
    item.target_new = Number(item.target_new || 0) + Number(entry.target_new || 0);
    item.pages = Number(item.pages || 0) + Number(entry.pages || 0);
    // 停止原因以“采集阶段”的为准；入库阶段只补新增/待补计数。
    if (entry.stage === "collect" && entry.stop_reason) item.stop_reason = entry.stop_reason;
    if (entry.errors) item.errors.push(...[].concat(entry.errors).filter(Boolean));
    if (entry.match_score != null) item.match_score = entry.match_score;
    if (entry.is_new_keyword) item.is_new_keyword = true;
    if (entry.priority != null) item.priority = entry.priority;
    for (const field of SUM_FIELDS) item[field] = Number(item[field] || 0) + Number(entry[field] || 0);
  }
  return [...map.values()].map((item) => ({ ...item, errors: [...new Set(item.errors)].slice(0, 5) }));
}

function channelTotals(merged) {
  const map = new Map();
  for (const item of merged || []) {
    const key = item.channel || "未知渠道";
    if (!map.has(key)) map.set(key, { channel: key, keywords: 0, seen: 0, duplicates: 0, new_primary: 0, new_duplicate: 0, detail_fail: 0, pending: 0, pages: 0 });
    const row = map.get(key);
    row.keywords += 1;
    row.seen += Number(item.seen || 0);
    row.duplicates += Number(item.duplicates || 0);
    row.new_primary += Number(item.ingested_primary || 0);
    row.new_duplicate += Number(item.ingested_duplicate || 0);
    row.detail_fail += Number(item.detail_fail || 0);
    row.pending += Number(item.pending || 0);
    row.pages += Number(item.pages || 0);
  }
  return [...map.values()];
}

function writeDailySummary(dateKey, merged, options = {}) {
  const filePath = path.join(options.outputsDir || outputsDir, `collection_ledger_${dateKey}.md`);
  const channels = channelTotals(merged);
  const lines = [
    `# 采集账本 ${dateKey}`,
    "",
    "## 渠道汇总",
    "",
    "| 渠道 | 关键词数 | 看到 | 重复 | 新增主记录 | 新增重复 | 详情失败 | 待补 | 页数 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...channels.map((item) => `| ${item.channel} | ${item.keywords} | ${item.seen} | ${item.duplicates} | ${item.new_primary} | ${item.new_duplicate} | ${item.detail_fail} | ${item.pending} | ${item.pages} |`),
    "",
    "## 关键词明细",
    "",
    "| 渠道 | 关键词 | 目标新增 | 看到 | 重复 | 详情成功 | 详情失败 | 待补 | 新增主记录 | 新增重复 | 页数 | 停止原因 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...merged.map((item) => `| ${item.channel} | ${item.keyword} | ${item.target_new || ""} | ${item.seen || 0} | ${item.duplicates || 0} | ${item.detail_ok || 0} | ${item.detail_fail || 0} | ${item.pending || 0} | ${item.ingested_primary || 0} | ${item.ingested_duplicate || 0} | ${item.pages || 0} | ${item.stop_reason || ""} |`),
    "",
    "说明：看到/重复来自采集阶段；新增主记录/新增重复来自入库阶段；详情失败和待补会进入下一轮补采。",
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\r\n"), "utf8");
  return filePath;
}

function writeDailyJson(dateKey, merged, options = {}) {
  const filePath = path.join(options.outputsDir || outputsDir, `collection_ledger_${dateKey}.json`);
  writeJsonAtomic(filePath, { date: dateKey, channels: channelTotals(merged), rows: merged });
  return filePath;
}

function pruneLedger(days = 90, now = new Date()) {
  if (!fs.existsSync(ledgerDir)) return [];
  const cutoff = now.getTime() - days * 86400000;
  const removed = [];
  for (const name of fs.readdirSync(ledgerDir)) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    const time = new Date(`${match[1]}T00:00:00+08:00`).getTime();
    if (Number.isFinite(time) && time < cutoff) {
      fs.unlinkSync(path.join(ledgerDir, name));
      removed.push(name);
    }
  }
  return removed;
}

module.exports = {
  ledgerPath,
  appendLedgerEntries,
  readLedger,
  readRecentLedger,
  mergeDay,
  channelTotals,
  writeDailySummary,
  writeDailyJson,
  pruneLedger,
};
