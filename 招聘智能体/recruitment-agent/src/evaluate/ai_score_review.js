const path = require("path");
const { runAiTask } = require("../core/ai_router");
const { readJson, writeJsonAtomic } = require("../core/atomic_json");
const { deriveFocus, clamp } = require("./score_job_facts");

const rootDir = path.resolve(__dirname, "..", "..");
const cachePath = path.join(rootDir, "data", "ai_score_cache.json");

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cacheKey(row, ruleVersion, candidateVersion, model) {
  return `${row.job_store_key || row.record_key || ""}|${ruleVersion}|${candidateVersion}|${model || "default"}|${row.facts?.content_hash || row.content_hash || ""}`;
}

function loadCache() {
  const state = readJson(cachePath, null);
  return { version: 1, entries: (state && state.entries) || {} };
}

function saveCache(state) {
  const entries = Object.entries(state.entries || {}).slice(-5000);
  writeJsonAtomic(cachePath, { version: 1, updated_at: new Date().toISOString(), entries: Object.fromEntries(entries) }, { backup: true });
}

function compactJob(row) {
  const score = row.score || {};
  return {
    key: row.job_store_key || row.record_key || "",
    display_id: row.display_id || "",
    platform: row.platform || "",
    company: row.company || "",
    job_title: row.job_title || "",
    salary: row.salary || "",
    location: row.district || row.city || row.address || "",
    job_text: String(row.job_description || "").slice(0, 2600),
    hard_status: score.hard?.status || "",
    hard_failures: score.hard?.failures || [],
    deterministic_overall: score.overall ?? row.overall_fit_score ?? 0,
    deterministic_success: score.success ?? row.application_success_score ?? 0,
    soft_scores: score.soft || {},
    reasons: score.reasons || [],
    risks: score.risks || [],
    focus_level: score.focus_level || row.focus_level || "",
  };
}

function parseAiJson(text) {
  const cleaned = String(text || "").replace(/^```json\s*|\s*```$/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return { reviews: parsed };
    return parsed || {};
  } catch {
    return {};
  }
}

function normalizeReview(item) {
  const delta = Number(item.delta ?? item.score_delta ?? item.adjustment ?? 0);
  return {
    delta: Number.isFinite(delta) ? delta : 0,
    reasons: Array.isArray(item.reasons) ? item.reasons.map((value) => String(value)).filter(Boolean).slice(0, 4) : [],
    risks: Array.isArray(item.risks) ? item.risks.map((value) => String(value)).filter(Boolean).slice(0, 4) : [],
    summary: String(item.summary || item.explanation || "").slice(0, 300),
    action: String(item.action || "").slice(0, 80),
  };
}

function applyReview(row, review, meta, rules) {
  const score = row.score || {};
  if (!score.hard || score.hard.status !== "pass") {
    score.ai = { used: false, status: "skipped_hard_condition", provider: meta.provider, model: meta.model, delta: 0, reasons: [], risks: [] };
    return { ...row, score };
  }
  const maxDelta = finiteNumber(meta.maxDelta, 8);
  const delta = Math.max(-maxDelta, Math.min(maxDelta, Math.round(finiteNumber(review.delta, 0))));
  const nextOverall = clamp((score.overall ?? row.overall_fit_score ?? 0) + delta);
  const nextSuccess = clamp((score.success ?? row.application_success_score ?? 0) + delta);
  const focus = deriveFocus(nextOverall, nextSuccess, score.hard, rules);
  score.overall = nextOverall;
  score.success = nextSuccess;
  score.focus_level = focus.focus_level;
  score.recommendation = focus.recommendation;
  score.action = focus.action;
  score.reasons = [...new Set([...(score.reasons || []), ...review.reasons])].slice(0, 8);
  score.risks = [...new Set([...(score.risks || []), ...review.risks])].slice(0, 8);
  score.ai = {
    used: true,
    status: meta.cacheHit ? "cache_hit" : "success",
    provider: meta.provider,
    model: meta.model,
    delta,
    reasons: review.reasons,
    risks: review.risks,
    summary: review.summary,
    action: review.action,
  };
  return {
    ...row,
    overall_fit_score: nextOverall,
    application_success_score: nextSuccess,
    focus_level: focus.focus_level,
    application_recommendation: focus.recommendation,
    score,
    match_reasons_json: JSON.stringify(score.reasons || []),
    risk_reasons_json: JSON.stringify(score.risks || []),
    evaluation_summary: `${String(row.evaluation_summary || "").slice(0, 320)}${review.summary ? `；AI复核：${review.summary.slice(0, 160)}` : ""}`.slice(0, 500),
    ai_evaluation_status: meta.cacheHit ? "cache_hit" : "success",
    ai_evaluation_provider: meta.provider || "",
    ai_evaluation_model: meta.model || "",
  };
}

// AI 只对“规则分较高且硬条件已通过”的少量岗位做辅助复核：
// 1) 不参与硬条件；2) 分数只能在 ±N 内微调；3) 结果缓存；4) 默认关闭时完全不调用。
async function reviewScores(scoredRows, options = {}) {
  const rules = options.rules || {};
  const candidate = options.candidate || {};
  const ruleVersion = options.ruleVersion || "";
  const candidateVersion = options.candidateVersion || "";
  const maxRows = Math.max(0, finiteNumber(options.maxRows ?? envNumber("AI_SCORE_REVIEW_MAX_ROWS", 8), 8));
  const minScore = finiteNumber(options.minScore ?? envNumber("AI_SCORE_REVIEW_MIN_SCORE", 50), 50);
  const maxDelta = finiteNumber(options.maxDelta ?? envNumber("AI_SCORE_REVIEW_MAX_DELTA", 8), 8);
  const model = String(options.model || process.env.AI_SCORE_REVIEW_MODEL || process.env.AI_DEFAULT_MODEL || "default");
  if (!maxRows || !Array.isArray(scoredRows) || !scoredRows.length) {
    return { ok: true, skipped: true, reason: "no_rows", rows: scoredRows };
  }

  const selected = scoredRows
    .filter((row) => (row.record_status || "active") !== "duplicate")
    .filter((row) => row.score && row.score.hard && row.score.hard.status === "pass")
    .filter((row) => Number(row.score.overall ?? row.overall_fit_score ?? 0) >= minScore)
    .sort((a, b) => Number(b.score?.overall || 0) - Number(a.score?.overall || 0))
    .slice(0, maxRows);
  if (!selected.length) return { ok: true, skipped: true, reason: "no_eligible_rows", rows: scoredRows };

  const cache = loadCache();
  const cachedRows = [];
  const pendingRows = [];
  for (const row of selected) {
    const entry = cache.entries[cacheKey(row, ruleVersion, candidateVersion, model)];
    if (entry) cachedRows.push({ row, review: normalizeReview(entry), meta: { cacheHit: true, provider: entry.provider || "", model: entry.model || model } });
    else pendingRows.push(row);
  }

  let aiResult = null;
  if (pendingRows.length) {
    const jobs = pendingRows.map(compactJob);
    aiResult = await runAiTask({
      purpose: "score_review",
      options: { max_output_tokens: Math.max(1200, pendingRows.length * 120) },
      instructions: [
        "你是求职岗位评分的复核助手。只做解释和少量微调，不改变硬条件结果，不虚构候选人经历或岗位事实。",
        "硬条件已经由程序判定；hard_status 不是 pass 的岗位不会被送给你。",
        "对每个岗位给出 delta（整数，-8 到 8 之间），只允许微调 overall 分数；reasons/risks 必须基于输入事实。",
        "只返回 JSON：{\"reviews\":[{\"key\":\"...\",\"delta\":0,\"reasons\":[\"...\"],\"risks\":[\"...\"],\"summary\":\"...\",\"action\":\"...\"}]}",
      ].join("\n"),
      input: {
        candidate: {
          target_cities: candidate.cities || [],
          target_salary_k: candidate.target_salary_k || {},
          target_roles: candidate.target_roles || [],
          strengths: candidate.strengths || [],
          avoid_title_keywords: candidate.avoid_title_keywords || [],
          avoid_jd_keywords: candidate.avoid_jd_keywords || [],
          profile_excerpt: String(candidate.profile_excerpt || "").slice(0, 3000),
        },
        scoring: {
          weights: rules.weights || {},
          thresholds: rules.thresholds || {},
          hard: rules.hard || {},
        },
        jobs,
      },
    });
  }

  const byKey = new Map();
  if (aiResult?.ok) {
    const parsed = parseAiJson(aiResult.text);
    const items = Array.isArray(parsed.reviews) ? parsed.reviews : (Array.isArray(parsed.evaluations) ? parsed.evaluations : []);
    for (const item of items) {
      const key = String(item.key || item.job_store_key || item.index || "");
      byKey.set(key, normalizeReview(item));
    }
  }

  const resultRows = [...scoredRows];
  const updates = new Map();
  for (const { row, review, meta } of cachedRows) {
    updates.set(row.job_store_key, applyReview(row, review, { ...meta, maxDelta, cacheHit: true }, rules));
  }
  if (aiResult?.ok) {
    pendingRows.forEach((row, index) => {
      const key = String(row.job_store_key || row.record_key || "");
      const review = byKey.get(key) || byKey.get(String(index)) || null;
      if (!review) return;
      updates.set(row.job_store_key, applyReview(row, review, { provider: aiResult.provider, model: aiResult.model, maxDelta, cacheHit: false }, rules));
      cache.entries[cacheKey(row, ruleVersion, candidateVersion, model)] = {
        ...review,
        provider: aiResult.provider,
        model: aiResult.model,
        updated_at: new Date().toISOString(),
      };
    });
  }

  const merged = resultRows.map((row) => updates.get(row.job_store_key) || row);
  if (Object.keys(cache.entries).length) saveCache(cache);
  return {
    ok: Boolean(aiResult?.ok) || cachedRows.length > 0,
    skipped: false,
    provider: aiResult?.provider || "",
    model: aiResult?.model || model,
    selected: selected.length,
    cached: cachedRows.length,
    reviewed: updates.size,
    reason: aiResult && !aiResult.ok ? aiResult.reason : "",
    rows: merged,
  };
}

module.exports = { reviewScores, applyReview, cacheKey, loadCache, cachePath };
