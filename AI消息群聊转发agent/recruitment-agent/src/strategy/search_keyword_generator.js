const fs = require("fs");
const path = require("path");
const { loadCurrentCandidateProfile } = require("../greeting/candidate_profile");
const { runAiTask } = require("../core/ai_router");

const rootDir = path.resolve(__dirname, "..", "..");
const strategyPath = path.join(rootDir, "config", "search_strategy.json");
const outputsDir = path.join(rootDir, "outputs");

function loadStaticStrategy() {
  return JSON.parse(fs.readFileSync(strategyPath, "utf8"));
}

function parseKeywordStrategy(text, fallback) {
  try {
    const parsed = JSON.parse(String(text).replace(/^```json\s*|\s*```$/g, ""));
    const levels = (parsed.levels || []).map((level) => ({
      type: String(level.type || "AI生成关键词").slice(0, 30),
      description: String(level.description || "根据候选人画像和目标岗位生成").slice(0, 120),
      keywords: [...new Set((level.keywords || []).map((item) => String(item).trim()).filter((item) => item && item.length <= 40))].slice(0, 20),
    })).filter((level) => level.keywords.length);
    return levels.length ? { ...fallback, levels } : fallback;
  } catch { return fallback; }
}

function listRecentOutputFiles(pattern, limit = 30) {
  if (!fs.existsSync(outputsDir)) return [];
  return fs.readdirSync(outputsDir)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const fullPath = path.join(outputsDir, name);
      return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

function keywordBucket(map, keyword) {
  const normalized = String(keyword || "").trim();
  if (!normalized) return null;
  if (!map.has(normalized)) {
    map.set(normalized, {
      keyword: normalized,
      strategyTypes: new Set(),
      platforms: new Set(),
      rawRuns: 0,
      rawCandidates: 0,
      collectedRecords: 0,
      errorRuns: 0,
      lastError: "",
      evaluatedRows: 0,
      recommendableRows: 0,
      overallScoreSum: 0,
      successScoreSum: 0,
    });
  }
  return map.get(normalized);
}

function avg(sum, count) {
  return count ? Number((sum / count).toFixed(1)) : null;
}

function loadHistoricalSearchInsights() {
  const byKeyword = new Map();
  const rawFiles = listRecentOutputFiles(/^(boss|liepin)_daily_\d{8}_jobs_.*\.json$/, 40);
  for (const file of rawFiles) {
    try {
      const platform = file.name.startsWith("boss_") ? "boss" : "liepin";
      const payload = JSON.parse(fs.readFileSync(file.fullPath, "utf8"));
      const records = Array.isArray(payload.records) ? payload.records : [];
      const recordsByKeyword = new Map();
      for (const row of records) {
        const keyword = String(row.keyword || "").trim();
        if (!keyword) continue;
        recordsByKeyword.set(keyword, (recordsByKeyword.get(keyword) || 0) + 1);
      }
      for (const stat of Array.isArray(payload.keywordStats) ? payload.keywordStats : []) {
        const bucket = keywordBucket(byKeyword, stat.keyword);
        if (!bucket) continue;
        bucket.platforms.add(platform);
        if (stat.strategyType || stat.strategy_type) bucket.strategyTypes.add(stat.strategyType || stat.strategy_type);
        bucket.rawRuns += 1;
        bucket.rawCandidates += Number(stat.candidates || stat.count || 0) || 0;
        bucket.collectedRecords += recordsByKeyword.get(bucket.keyword) || 0;
        if (stat.collectionError) {
          bucket.errorRuns += 1;
          bucket.lastError = String(stat.collectionError).replace(/\s+/g, " ").slice(0, 160);
        }
      }
    } catch {
      // Historical insights are advisory only; ignore malformed old artifacts.
    }
  }

  const evaluatedFiles = listRecentOutputFiles(/^(boss|liepin)_.*fit_evaluated_.*\.json$/, 40);
  for (const file of evaluatedFiles) {
    try {
      const platform = file.name.startsWith("boss_") ? "boss" : "liepin";
      const payload = JSON.parse(fs.readFileSync(file.fullPath, "utf8"));
      for (const row of Array.isArray(payload.records) ? payload.records : []) {
        const bucket = keywordBucket(byKeyword, row.keyword);
        if (!bucket) continue;
        bucket.platforms.add(platform);
        bucket.evaluatedRows += 1;
        bucket.overallScoreSum += Number(row.overall_fit_score || 0) || 0;
        bucket.successScoreSum += Number(row.application_success_score || 0) || 0;
        if (/重点关注|可关注/.test(String(row.focus_level || ""))) bucket.recommendableRows += 1;
      }
    } catch {
      // Historical insights are advisory only; ignore malformed old artifacts.
    }
  }

  const rows = Array.from(byKeyword.values()).map((item) => ({
    keyword: item.keyword,
    strategyTypes: Array.from(item.strategyTypes).slice(0, 3),
    platforms: Array.from(item.platforms).slice(0, 3),
    rawRuns: item.rawRuns,
    rawCandidates: item.rawCandidates,
    collectedRecords: item.collectedRecords,
    errorRuns: item.errorRuns,
    evaluatedRows: item.evaluatedRows,
    avgOverallFit: avg(item.overallScoreSum, item.evaluatedRows),
    avgApplicationSuccess: avg(item.successScoreSum, item.evaluatedRows),
    recommendableRows: item.recommendableRows,
    lastError: item.lastError,
  }));

  const useful = [...rows]
    .sort((a, b) => (b.recommendableRows - a.recommendableRows)
      || ((b.avgOverallFit || 0) - (a.avgOverallFit || 0))
      || (b.collectedRecords - a.collectedRecords))
    .slice(0, 20);
  const riskyOrLowYield = [...rows]
    .filter((item) => item.errorRuns || (item.rawRuns >= 2 && item.collectedRecords === 0))
    .sort((a, b) => (b.errorRuns - a.errorRuns) || (a.collectedRecords - b.collectedRecords))
    .slice(0, 15);

  return {
    lookbackFiles: { raw: rawFiles.length, evaluated: evaluatedFiles.length },
    usefulKeywords: useful,
    riskyOrLowYieldKeywords: riskyOrLowYield,
  };
}

async function resolveSearchStrategy() {
  const fallback = loadStaticStrategy();
  let candidate = {};
  try {
    const profile = loadCurrentCandidateProfile();
    candidate = { id: profile.id, profile: profile.markdown.slice(0, 10000) };
  } catch (error) {
    return { strategy: fallback, ai: { used: false, fallback: "static", reason: `候选人画像不可用：${error.message}` } };
  }
  const ai = await runAiTask({
    purpose: "search_keywords",
    options: { max_output_tokens: 1400 },
    instructions: "根据候选人画像、目标城市、现有搜索策略和历史关键词效果，优化招聘网站搜索关键词。只返回 JSON：{\"levels\":[{\"type\":\"岗位信息|经历关键词|宽泛词\",\"description\":\"...\",\"keywords\":[\"...\"]}]}。保留历史上能产出高匹配岗位的有效关键词；减少重复首页、空结果、频繁触发平台异常或低转化关键词；补充 AI+项目、AI+交付、AI+产品、智能体/Agent/大模型+项目管理 等职责组合词；避免无关、过长、招聘网站难以检索的词；不要虚构候选人经历。",
    input: { candidate, current_strategy: fallback, historical_search_insights: loadHistoricalSearchInsights() },
  });
  if (!ai.ok) return { strategy: fallback, ai: { used: false, fallback: "static", reason: ai.reason || "AI 未返回结果" } };
  return { strategy: parseKeywordStrategy(ai.text, fallback), ai: { used: true, provider: ai.provider, model: ai.model, fallback: ai.fallback } };
}

module.exports = { resolveSearchStrategy, loadStaticStrategy };
