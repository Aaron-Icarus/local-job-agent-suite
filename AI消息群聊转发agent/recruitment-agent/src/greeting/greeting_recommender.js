const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadCurrentCandidateProfile } = require("./candidate_profile");

const rootDir = path.resolve(__dirname, "..", "..");

function appendAiLog(event) {
  const filePath = path.join(rootDir, "logs", "ai_calls.log");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

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
  const profile = loadCurrentCandidateProfile();
  if (profile.id === "sample_candidate" || /候选人画像示例（请替换）/.test(profile.markdown)) {
    return {
      message: "候选人画像尚未配置。请先填写自己的真实、可验证经历和求职目标，再生成用于联系招聘方的打招呼话术。",
      strategy: "rules:profile-required",
      basis: "candidate_profile_not_configured",
    };
  }
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

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function callOpenAiGreeting(row, options = {}) {
  const apiKey = process.env.GREETING_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY or GREETING_OPENAI_API_KEY is not set");
  const baseUrl = (process.env.GREETING_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.GREETING_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
  const maxLength = options.maxLength || envNumber("GREETING_MAX_LENGTH", 200);
  const timeoutMs = envNumber("GREETING_AI_TIMEOUT_MS", 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        instructions: "你负责为应聘者向招聘方发出的第一句中文打招呼生成文案。仅输出一段可直接发送的中文，不要标题、编号、解释或换行。仔细阅读候选人画像和单个岗位信息：优先引用候选人最近 3 年内、且与岗位职责直接相关的经验；只有不相关时才使用最近 5 年经历。每条只突出 1-2 个最贴合该 JD 的可验证经历或能力，最好体现该岗位的业务场景、职责或公司方向；不要堆砌通用能力标签，不要虚构经历或将项目交付说成算法研发。语气自然、专业、主动。尽量控制在 100 个中文字符内，最长不能超过指定上限。",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify({
              max_length: maxLength,
              candidate: currentCandidatePayload(),
              job: compactJobPayload(row),
            }) }],
          },
        ],
        text: { format: { type: "text" } },
        max_output_tokens: envNumber("GREETING_AI_MAX_OUTPUT_TOKENS", 220),
      }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(payload.error?.message || `OpenAI request failed with status ${resp.status}`);
    const message = normalizeGreetingLength(extractResponseText(payload), { maxLength });
    if (!message) throw new Error("OpenAI response did not contain text");
    return {
      message,
      strategy: `ai:${model}`,
      basis: `OpenAI Responses API generated from JD and current candidate profile (${currentCandidatePayload().candidate_id})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function runCommand(command, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex runtime timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Codex runtime exited ${code}: ${stderr.slice(-500)}`));
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function callCodexRuntimeGreeting(row, options = {}) {
  const command = process.env.CODEX_RUNTIME_COMMAND;
  if (!command) throw new Error("CODEX_RUNTIME_COMMAND is not configured");
  const maxLength = options.maxLength || envNumber("GREETING_MAX_LENGTH", 200);
  const timeoutMs = envNumber("CODEX_RUNTIME_TIMEOUT_MS", envNumber("GREETING_AI_TIMEOUT_MS", 15000));
  const payload = {
    task: "recruiter_greeting",
    instructions: "只返回可直接发送的中文招聘打招呼话术；100-200字以内；优先使用候选人最近3年可验证经历，不虚构。",
    max_length: maxLength,
    candidate: currentCandidatePayload(),
    job: compactJobPayload(row)
  };
  const raw = await runCommand(command, payload, timeoutMs);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { text: raw }; }
  const message = normalizeGreetingLength(parsed.output_text || parsed.text || parsed.message || "", { maxLength });
  if (!message) throw new Error("Codex runtime response did not contain text");
  return {
    message,
    strategy: "ai:codex_runtime",
    basis: "Codex runtime generated from current candidate profile and JD"
  };
}

async function recommendGreetingResult(row, options = {}) {
  const mode = String(options.mode || process.env.GREETING_MODE || "auto").toLowerCase();
  const maxLength = options.maxLength || envNumber("GREETING_MAX_LENGTH", 200);
  const fallback = envBool("GREETING_AI_FALLBACK", true);
  const ruleResult = () => ruleGreetingResult(row, { maxLength });
  const initialRuleResult = ruleResult();
  if (initialRuleResult.strategy === "rules:profile-required") return initialRuleResult;
  if (mode === "rules" || mode === "rule") return initialRuleResult;
  const providers = mode === "api" || mode === "openai_api"
    ? ["openai_api"]
    : mode === "codex" || mode === "codex_runtime"
      ? ["codex_runtime"]
      : String(process.env.GREETING_AI_PROVIDER_ORDER || "codex_runtime,openai_api").split(",").map((item) => item.trim()).filter(Boolean);
  const errors = [];
  for (const provider of providers) {
    try {
      const result = provider === "codex_runtime"
        ? await callCodexRuntimeGreeting(row, { maxLength })
        : await callOpenAiGreeting(row, { maxLength });
      appendAiLog({ purpose: "recruiter_greeting", provider, status: "success", strategy: result.strategy });
      return result;
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      appendAiLog({ purpose: "recruiter_greeting", provider, status: "failed", error: error.message });
    }
  }
  if (!fallback) throw new Error(`AI unavailable: ${errors.join("; ")}`);
  return { ...ruleResult(), strategy: "rules:ai-fallback", basis: `AI unavailable: ${errors.join("; ")}` };
}

module.exports = { recommendGreeting, recommendGreetingResult };
