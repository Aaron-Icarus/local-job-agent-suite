const fs = require("fs");
const path = require("path");
const { loadCurrentCandidateProfile } = require("../greeting/candidate_profile");
const { runAiTask } = require("../core/ai_router");

const rootDir = path.resolve(__dirname, "..", "..");
const strategyPath = path.join(rootDir, "config", "search_strategy.json");

function loadStaticStrategy() { return JSON.parse(fs.readFileSync(strategyPath, "utf8")); }
function parseKeywordStrategy(text, fallback) {
  try {
    const parsed = JSON.parse(String(text).replace(/^```json\s*|\s*```$/g, ""));
    const levels = (parsed.levels || []).map((level) => ({ type: String(level.type || "AI生成关键词").slice(0, 30), description: String(level.description || "根据候选人画像和目标岗位生成").slice(0, 120), keywords: [...new Set((level.keywords || []).map((item) => String(item).trim()).filter((item) => item && item.length <= 40))].slice(0, 20) })).filter((level) => level.keywords.length);
    return levels.length ? { ...fallback, levels } : fallback;
  } catch { return fallback; }
}
async function resolveSearchStrategy() {
  const fallback = loadStaticStrategy();
  let candidate = {};
  try { const profile = loadCurrentCandidateProfile(); candidate = { id: profile.id, profile: profile.markdown.slice(0, 10000) }; } catch (error) { return { strategy: fallback, ai: { used: false, fallback: "static", reason: `候选人画像不可用：${error.message}` } }; }
  const ai = await runAiTask({ purpose: "search_keywords", options: { max_output_tokens: 1400 }, instructions: "根据候选人画像、目标城市和现有搜索策略，优化招聘网站搜索关键词。只返回 JSON：{\"levels\":[{\"type\":\"岗位信息|经历关键词|宽泛词\",\"description\":\"...\",\"keywords\":[\"...\"]}]}。保留现有有效关键词，补充同义职位和职责组合；避免无关、过长、招聘网站难以检索的词；不要虚构候选人经历。", input: { candidate, current_strategy: fallback } });
  if (!ai.ok) return { strategy: fallback, ai: { used: false, fallback: "static", reason: ai.reason || "AI 未返回结果" } };
  return { strategy: parseKeywordStrategy(ai.text, fallback), ai: { used: true, provider: ai.provider, model: ai.model, fallback: ai.fallback } };
}
module.exports = { resolveSearchStrategy, loadStaticStrategy };
