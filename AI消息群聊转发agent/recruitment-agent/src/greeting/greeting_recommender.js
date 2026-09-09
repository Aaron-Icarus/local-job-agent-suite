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
    "我也愿意结合岗位实际职责进一步说明相关经历和可落地的协作方式，期待与您沟通。",
    "如有机会，希望结合团队当前业务目标和岗位重点，分享我在需求拆解、实现推进及问题闭环方面的实践。"
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

function candidateProfileTextSafe() {
  try {
    return loadCurrentCandidateProfile().markdown || "";
  } catch {
    return "";
  }
}

function pushIfMatched(strengths, text, regex, label) {
  if (regex.test(text)) strengths.push(label);
}

function inferRuleStrengths(row) {
  const jobText = textOf(row);
  const profileText = candidateProfileTextSafe();
  const combined = `${profileText} ${jobText}`;
  const title = String(row.job_title || "");
  const strengths = [];

  pushIfMatched(strengths, combined, /Java|Spring\s*Boot|Spring\s*Cloud/i, "Java/Spring Boot后端开发");
  pushIfMatched(strengths, combined, /微服务|分布式|REST|API|接口/i, "微服务和接口设计");
  pushIfMatched(strengths, combined, /MySQL|Redis|消息队列|MQ|Kafka|Rabbit/i, "MySQL/Redis/消息队列");
  pushIfMatched(strengths, combined, /React|Vue|TypeScript|Node\.?js|前端|全栈/i, "前后端协作和全栈开发");
  pushIfMatched(strengths, combined, /Docker|Kubernetes|K8s|CI\/CD|DevOps|云原生/i, "云原生部署和CI/CD");
  pushIfMatched(strengths, combined, /AI应用|大模型|RAG|知识库|智能体|AI\s*Agent|Agent/i, "AI应用工程化");
  pushIfMatched(strengths, combined, /需求|方案|评审|排期|代码评审|灰度|上线|故障|性能优化|问题闭环/i, "需求拆解、技术评审和上线闭环");

  if (/项目经理|项目管理|交付|PMO|实施|UAT|验收/i.test(title + jobText)) {
    pushIfMatched(strengths, combined, /项目|交付|实施|UAT|验收|客户|产研|跨部门/i, "项目推进和跨团队协作");
  }
  if (/产品|需求|方案|PRD|原型/i.test(title + jobText)) {
    pushIfMatched(strengths, combined, /产品|需求|方案|PRD|原型|流程/i, "产品需求和方案设计");
  }

  if (!strengths.length) {
    pushIfMatched(strengths, profileText, /开发|研发|工程|系统|平台/i, "软件研发");
  }
  if (!strengths.length) strengths.push("岗位相关项目实践");
  return [...new Set(strengths)].slice(0, 6);
}

function ruleGreetingResult(row, options = {}) {
  const maxLength = options.maxLength || 200;
  const uniqueStrengths = inferRuleStrengths(row);
  const prefix = "您好，";
  const suffix = "与岗位匹配，期待沟通。";
  const message = normalizeGreetingLength(`${prefix}我有${uniqueStrengths.join("、")}经验，能结合业务目标推进落地，${suffix}`, { maxLength });
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
  const configuredMode = String(options.mode || process.env.AI_GREETING_MODE || process.env.GREETING_MODE || "").trim().toLowerCase();
  const maxLength = options.maxLength || envNumber("GREETING_MAX_LENGTH", 200);
  const fallback = envBool("GREETING_AI_FALLBACK", true);
  const ruleResult = () => ruleGreetingResult(row, { maxLength });
  if (configuredMode === "rules" || configuredMode === "rule") return ruleResult();
  if (configuredMode === "disabled" || configuredMode === "off") {
    return { ...ruleResult(), strategy: "rules:ai-disabled", basis: "AI 已按配置关闭，使用规则模板" };
  }
  const aiOptions = { max_output_tokens: envNumber("GREETING_AI_MAX_OUTPUT_TOKENS", 220) };
  if (configuredMode) aiOptions.mode = configuredMode;
  const ai = await runAiTask({
    purpose: "greeting",
    options: aiOptions,
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
