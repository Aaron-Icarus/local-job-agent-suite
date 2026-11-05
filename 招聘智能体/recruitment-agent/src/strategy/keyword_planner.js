const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("../core/atomic_json");
const { readRecentLedger } = require("../store/collection_ledger");

const rootDir = path.resolve(__dirname, "..", "..");
const profilePath = path.join(rootDir, "data", "keyword_profiles.json");

const LEVEL_MATCH_SCORE = {
  岗位信息: 90,
  经历关键词: 72,
  宽泛词: 50,
};

function normalizeKeyword(keyword) {
  return String(keyword || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function daysBetween(left, right) {
  if (!left) return null;
  const a = new Date(`${String(left).slice(0, 10)}T00:00:00+08:00`);
  const b = new Date(`${String(right).slice(0, 10)}T00:00:00+08:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function loadProfiles(filePath = profilePath) {
  const state = readJson(filePath, null);
  return { version: 1, updated_at: "", keywords: (state && state.keywords) || {} };
}

function saveProfiles(profiles, filePath = profilePath) {
  writeJsonAtomic(filePath, { version: 1, updated_at: new Date().toISOString(), keywords: profiles.keywords || {} }, { backup: true });
}

function channelStats(profile, channel) {
  if (!profile || !profile.channels) return null;
  return profile.channels[channel] || null;
}

function scoreKeyword(meta, profile, channel, nowDate = new Date().toISOString().slice(0, 10)) {
  const match = Number(meta.match_score || LEVEL_MATCH_SCORE[meta.level_type] || 55);
  const stats = channelStats(profile, channel);
  const last = stats?.last || null;
  const seen = Number(last?.seen || 0);
  const newPrimary = Number(last?.new_primary || 0);
  const duplicates = Number(last?.duplicates || 0);
  const failures = Number(last?.failures || 0);
  const newRate = seen > 0 ? clamp01(newPrimary / seen) : 0;
  const duplicateRate = seen > 0 ? clamp01(duplicates / seen) : 0;
  const failureRate = seen > 0 ? clamp01(failures / seen) : 0;
  const lastUsedDate = stats?.last_used_date || last?.date || "";
  const recencyDays = lastUsedDate ? daysBetween(lastUsedDate, nowDate) : null;
  const recency = recencyDays === null ? 1 : clamp01(recencyDays / 14);
  // 从未用过的词不因为“没有渠道经验”被惩罚；给一个接近老词的渠道适配分。
  const channelFit = stats ? 1 : 0.8;
  const uses = Number(stats?.uses || 0);
  const usagePenalty = clamp01(uses / 10);
  const newBonus = !stats || uses === 0 ? 0.05 : 0;
  const priority = clamp01(
    (match / 100) * 0.35 +
    newRate * 0.25 +
    recency * 0.25 +
    channelFit * 0.15 +
    newBonus -
    duplicateRate * 0.2 -
    failureRate * 0.2 -
    usagePenalty * 0.05,
  );
  return {
    priority: Number(priority.toFixed(4)),
    match_score: match,
    new_rate: Number(newRate.toFixed(3)),
    duplicate_rate: Number(duplicateRate.toFixed(3)),
    failure_rate: Number(failureRate.toFixed(3)),
    recency_days: recencyDays,
    uses,
    is_new: !stats || uses === 0,
    last_used_date: stats?.last_used_date || "",
  };
}

function flattenLevels(levels) {
  const map = new Map();
  for (const level of levels || []) {
    for (const keyword of level.keywords || []) {
      const normalized = normalizeKeyword(keyword);
      if (!normalized) continue;
      if (!map.has(normalized)) {
        map.set(normalized, {
          keyword: String(keyword).trim(),
          level_type: level.type || "未分级",
          description: level.description || "",
          match_score: Number(level.match_score || LEVEL_MATCH_SCORE[level.type] || 55),
        });
      }
    }
  }
  return [...map.values()];
}

function planKeywords(options = {}) {
  const levels = options.levels || [];
  const channel = String(options.channel || "boss").toLowerCase();
  const totalNew = Math.max(1, Number(options.totalNew || 30));
  const perKeywordMax = Math.max(1, Number(options.perKeywordMax || 8));
  const maxPages = Math.max(1, Number(options.maxPages || 3));
  const maxQueue = Math.max(1, Number(options.maxQueue || 12));
  const profiles = options.profiles || loadProfiles(options.profilePath);
  const nowDate = options.nowDate || new Date().toISOString().slice(0, 10);
  const candidates = flattenLevels(levels).map((meta) => {
    const normalized = normalizeKeyword(meta.keyword);
    const profile = profiles.keywords[normalized];
    const scored = scoreKeyword(meta, profile, channel, nowDate);
    return { ...meta, ...scored, profile };
  });
  candidates.sort((a, b) => (b.priority - a.priority) || (b.match_score - a.match_score) || a.keyword.localeCompare(b.keyword, "zh-Hans-CN"));
  const queue = candidates.slice(0, maxQueue);
  // 先按队列平均分配“新增入库目标”，再把余数给靠前的词；
  // 这样每个词至少有机会跑一次，不会出现“第一个词吃满总配额、后面的词永远为 0”。
  const baseTarget = Math.max(1, Math.floor(totalNew / Math.max(1, queue.length)));
  const remainder = Math.max(0, totalNew - baseTarget * queue.length);
  return queue.map((item, index) => ({
    channel,
    keyword: item.keyword,
    strategy_type: item.level_type,
    level_type: item.level_type,
    description: item.description,
    match_score: item.match_score,
    priority: item.priority,
    is_new: item.is_new,
    last_used_date: item.last_used_date,
    recency_days: item.recency_days,
    uses: item.uses,
    target_new: Math.min(perKeywordMax, baseTarget + (index < remainder ? 1 : 0)),
    max_pages: maxPages,
    reason: [
      `匹配${item.match_score}`,
      `新增率${Math.round(item.new_rate * 100)}%`,
      item.is_new ? "从未使用" : `上次${item.recency_days ?? "?"}天前`,
      `重复率${Math.round(item.duplicate_rate * 100)}%`,
    ].join(" / "),
  }));
}

// 用最近账本重建关键词档案（幂等，重复运行不会重复累加）。
function rebuildProfilesFromLedger(options = {}) {
  const days = Number(options.days || 30);
  const entries = readRecentLedger(days, options.now || new Date());
  const byDayKeyword = new Map();
  for (const entry of entries) {
    if (entry.stage !== "collect" && entry.stage !== "ingest") continue;
    const day = entry.date || "";
    const channel = String(entry.channel || "").toLowerCase().includes("liepin") || entry.channel === "猎聘" ? "liepin" : "boss";
    const normalized = normalizeKeyword(entry.keyword);
    if (!day || !normalized) continue;
    const key = `${channel}|${day}|${normalized}`;
    if (!byDayKeyword.has(key)) byDayKeyword.set(key, { day, channel, keyword: entry.keyword, normalized, seen: 0, duplicates: 0, new_primary: 0, collect_candidates: 0, ingest_primary: 0, has_ingest: false, failures: 0, pages: 0, pending: 0, detail_ok: 0 });
    const item = byDayKeyword.get(key);
    item.seen += Number(entry.seen || 0);
    item.duplicates += Number(entry.duplicates || 0);
    if (entry.stage === "ingest") {
      item.has_ingest = true;
      item.ingest_primary += Number(entry.ingested_primary || 0);
      item.pending += Number(entry.pending_confirmed || 0);
    } else {
      item.collect_candidates += Number(entry.new_candidates || 0);
      item.pending += Number(entry.pending || 0);
    }
    item.failures += Number(entry.page_errors || 0) + Number(entry.detail_fail || 0);
    item.pages += Number(entry.pages || 0);
    item.detail_ok += Number(entry.detail_ok || 0);
  }
  const profiles = { version: 1, keywords: {} };
  for (const item of byDayKeyword.values()) {
    item.new_primary = item.has_ingest ? item.ingest_primary : item.collect_candidates;
    if (!profiles.keywords[item.normalized]) {
      profiles.keywords[item.normalized] = { keyword: item.keyword, first_used_date: item.day, last_used_date: "", uses: 0, channels: {} };
    }
    const profile = profiles.keywords[item.normalized];
    profile.first_used_date = profile.first_used_date < item.day ? profile.first_used_date : item.day;
    profile.last_used_date = profile.last_used_date > item.day ? profile.last_used_date : item.day;
    if (!profile.channels[item.channel]) profile.channels[item.channel] = { uses: 0, last_used_date: "", totals: { seen: 0, new_primary: 0, duplicates: 0, failures: 0, pages: 0, pending: 0 }, last: null, history: [] };
    const channel = profile.channels[item.channel];
    channel.uses += 1;
    channel.last_used_date = channel.last_used_date > item.day ? channel.last_used_date : item.day;
    channel.totals.seen += item.seen;
    channel.totals.new_primary += item.new_primary;
    channel.totals.duplicates += item.duplicates;
    channel.totals.failures += item.failures;
    channel.totals.pages += item.pages;
    channel.totals.pending += item.pending;
    channel.history.push({ date: item.day, seen: item.seen, new_primary: item.new_primary, duplicates: item.duplicates, failures: item.failures, pages: item.pages });
    channel.history = channel.history.sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
    if (!channel.last || channel.last.date <= item.day) {
      channel.last = {
        date: item.day,
        seen: item.seen,
        new_primary: item.new_primary,
        duplicates: item.duplicates,
        failures: item.failures,
        pages: item.pages,
        pending: item.pending,
        detail_ok: item.detail_ok,
      };
    }
    profile.uses = Object.values(profile.channels).reduce((sum, value) => sum + value.uses, 0);
  }
  saveProfiles(profiles, options.profilePath || profilePath);
  return profiles;
}

module.exports = {
  LEVEL_MATCH_SCORE,
  normalizeKeyword,
  loadProfiles,
  saveProfiles,
  scoreKeyword,
  flattenLevels,
  planKeywords,
  rebuildProfilesFromLedger,
  profilePath,
};
