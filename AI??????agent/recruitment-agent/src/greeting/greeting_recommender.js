const { loadCurrentCandidateProfile } = require("./candidate_profile");
const { runAiTask } = require("../core/ai_router");

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textOf(row) {
  return [
    row.job_title,
    row.job_description,
    row.page_card_text,
    row.tags,
    row.evaluation_summary,
    ...parseJsonField(row.match_reasons_json, []),
  ].join(" ");
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function trimMessage(text, maxLength = 200) {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1).replace(/[，、；。]+$/, "") + "。";
}

function normalizeGreetingLength(text, options = {}) {
  const maxLength = options.maxLength || 200;
  const minLength = Math.min(Number(options.minLength || process.env.GREETING_MIN_LENGTH || 100), maxLength);
  let message = trimMessage(text, maxLength);
  const additions = [
    "我也愿意结合岗位实际职责进一步说明相关项目经验和可落地的协作方式，期待与您沟通。",
    "如有机会，希望结合团队当前业务目标和岗位重点，分享我在需求协同、交付推进及问题闭环方面的实践。"
  ];
  for (const addition of additions) {
    if (message.length >= minLength) break;
    message = trimMessage(`${message}${addition}`, maxLength);
  }
  return message;
}

function envNumber(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function envBool(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function ruleGreetingResult(row, options = {}) {
  const maxLength = options.maxLength || 200;
  const text = textOf(row);
  const title = String(row.job_title || "");
  const isAiAgent = hasAny(text, [/智能体/i, /\bAgent\b/i, /AI\s*Agent/i, /大模型/i, /AGI/i]);
  const isPrivateDelivery = hasAny(text, [/私有化/i, /部署/i, /实施/i, /交付/i, /UAT/i, /验收/i, /系统集成/i]);
  const isProduct = hasAny(text, [/产品/i, /需求/i, /方案/i, /PRD/i, /原型/i, /流程/i]);
  const isOperation = hasAny(title + text, [/运营/i, /业务自动化/i, /推广/i, /培训/i, /一线/i, /效果评估/i]);
  const asksPmp = /PMP/i.test(text);
  const asksMcp = /\bMCP\b/i.test(text);
  const asksPrompt = /Prompt|提示词|低代码|Vibe/i.test(text);

  const strengths = [];
  if (isAiAgent) strengths.push("企业AGI智能体/大模型项目落地");
  else strengths.push("AI项目交付");
  if (isPrivateDelivery) strengths.push("私有化平台交付");
  if (isProduct || isOperation) strengths.push("需求梳理与方案设计");
  if (isOperation) strengths.push("一线培训推广和效果评估");
  if (asksPmp) strengths.push("PMP");
  if (asksMcp) strengths.push("MCP工具设计");
  if (asksPrompt) strengths.push("VibeCoding/AI工具实践");
  strengths.push("产研客户协同");
  strengths.push("UAT验收和问题闭环");

  const uniqueStrengths = [...new Set(strengths)].slice(0, 6);
  const prefix = "您好，";
  const suffix = "与岗位匹配，期待沟通。";
  const message = normalizeGreetingLength(`${prefix}我有${uniqueStrengths.join("、")}经验，负责过千万级AI项目，${suffix}`, { maxLength });
  return {
    message,
    strategy: "rules",
    basis: uniqueStrengths.join("、"),
  };
}

function recommendGreeting(row, options = {}) {
  const notConfigured = profileNotConfiguredText();
  if (notConfigured) return notConfigured.message;
  return ruleGreetingResult(row, options).message;
}

function compactJobPayload(row) {
  return {
    company: row.company || "",
    job_title: row.job_title || "",
    salary: row.salary || "",
    location: row.district || row.business_area || row.address || row.city || "",
    experience: row.experience || "",
    degree: row.degree || "",
    tags: row.tags || "",
    job_description: String(row.job_description || row.page_card_text || "").slice(0, 4000),
    match_reasons: parseJsonField(row.match_reasons_json, []).slice(0, 5),
    risk_reasons: parseJsonField(row.risk_reasons_json, []).slice(0, 5),
  };
}

function currentCandidatePayload() {
  const profile = loadCurrentCandidateProfile();
  return {
    candidate_id: profile.id,
    profile_markdown: profile.markdown.slice(0, 12000),
  };
}

// Shared/empty build safety: when the package still ships the sample candidate
// (or the profile cannot be loaded), never emit a fabricated-sounding template
// greeting. Ask the operator to fill in their own verifiable experience first.
function profileNotConfiguredText() {
  const message = "候选人画像尚未配置。请先填写自己的真实、可验证经历和求职目标，再生成用于联系招聘方的打招呼话术。";
  let profile = null;
  try {
    profile = loadCurrentCandidateProfile();
  } catch {
    return { message, strategy: "profile_not_configured", basis: "候选人画像缺失或无法读取" };
  }
  if (profile.id === "sample_candidate" || /候选人画像示例（请替换）/.test(profile.markdown)) {
    return { message, strategy: "profile_not_configured", basis: "当前为示例候选人画像，尚未替换为真实经历" };
  }
  return null;
}

async function recommendGreetingResult(row, options = {}) {
  const notConfigured = profileNotConfiguredText();
  if (notConfigured) return notConfigured;
  const mode = String(options.mode || process.env.GREETING_MODE || "auto").toLowerCase();
  const maxLength = options.maxLength || envNumber("GREETING_MAX_LENGTH", 200);
  const fallback = envBool("GREETING_AI_FALLBACK", true);
  const ruleResult = () => ruleGreetingResult(row, { maxLength });
  if (mode === "rules" || mode === "rule") return ruleResult();
  const ai = await runAiTask({
    purpose: "greeting",
    options: { mode, max_output_tokens: envNumber("GREETING_AI_MAX_OUTPUT_TOKENS", 220) },
    instructions: "你负责为应聘者向招聘方发出的第一句中文打招呼生成文案。仅输出一段可直接发送的中文，不要标题、编号、解释或换行。只使用候选人画像中可验证事实，优先最近三年与岗位直接相关经历；不要虚构或堆砌能力。语气自然、专业、主动，控制在指定长度内。",
    input: { max_length: maxLength, candidate: currentCandidatePayload(), job: compactJobPayload(row) },
  });
  if (ai.ok) {
    const message = normalizeGreetingLength(ai.text, { maxLength });
    if (message) return { message, strategy: `ai:${ai.provider}:${ai.model}`, basis: `AI Router ${ai.fallback ? "default fallback" : "configured provider"}` };
  }
  if (!fallback) throw new Error(`AI 调用不可用：${ai.reason || "未返回有效文本"}`);
  return { ...ruleResult(), strategy: "rules:ai-fallback", basis: `AI 未调用成功：${ai.reason || "未返回有效文本"}` };
}

module.exports = { recommendGreeting, recommendGreetingResult };
