const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..", "..");

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function purposeKey(purpose) {
  return String(purpose || "default").replace(/[^a-z0-9]+/gi, "_").toUpperCase();
}

function splitList(value, fallback) {
  return String(value || fallback || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function providerListForMode(mode, configuredProviders, defaultProviders) {
  const normalized = String(mode || "auto").toLowerCase();
  if (["rules", "disabled"].includes(normalized)) return [];
  if (["codex", "codex_runtime"].includes(normalized)) return ["codex_runtime"];
  if (["api", "openai", "openai_api"].includes(normalized)) return ["openai_api"];
  return configuredProviders.length ? configuredProviders : defaultProviders;
}

function appendAiLog(event) {
  const filePath = path.join(rootDir, "logs", "ai_calls.log");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function resolveAiConfig(purpose, overrides = {}) {
  const key = purposeKey(purpose);
  const legacy = key === "GREETING" ? "GREETING" : key === "PROFILE" ? "PROFILE" : "";
  const defaultMode = process.env.AI_DEFAULT_MODE || "disabled";
  const configuredMode = overrides.mode || process.env[`AI_${key}_MODE`] || (legacy && process.env[`${legacy}_MODE`]);
  const requestedMode = configuredMode || defaultMode;
  const defaultProviders = splitList(process.env.AI_DEFAULT_PROVIDER_ORDER, "codex_runtime,openai_api");
  const configuredProviderValue = overrides.provider_order || process.env[`AI_${key}_PROVIDER_ORDER`] || (legacy && process.env[`${legacy}_AI_PROVIDER_ORDER`]) || "";
  const requestedProviders = splitList(configuredProviderValue, "");
  const configuredModel = overrides.model || process.env[`AI_${key}_MODEL`] || (legacy && process.env[`${legacy}_OPENAI_MODEL`]) || "";
  const defaultModel = process.env.AI_DEFAULT_MODEL || process.env.OPENAI_MODEL || "";
  const defaultRoute = { tier: "default", mode: String(defaultMode).toLowerCase(), providers: providerListForMode(defaultMode, [], defaultProviders), model: defaultModel };
  const hasStepRoute = Boolean(configuredMode || configuredProviderValue || configuredModel || overrides.mode || overrides.provider_order || overrides.model);
  const stepRoute = hasStepRoute ? { tier: "step", mode: String(requestedMode).toLowerCase(), providers: providerListForMode(requestedMode, requestedProviders, defaultProviders), model: configuredModel || defaultModel } : null;
  const routes = stepRoute ? [stepRoute, defaultRoute] : [defaultRoute];
  return {
    purpose, key, mode: String(requestedMode).toLowerCase(), providers: routes.flatMap((route) => route.providers), model: stepRoute?.model || defaultModel, routes,
    timeoutMs: envNumber(process.env[`AI_${key}_TIMEOUT_MS`] || process.env.AI_DEFAULT_TIMEOUT_MS, 30000),
    maxOutputTokens: envNumber(overrides.max_output_tokens || process.env[`AI_${key}_MAX_OUTPUT_TOKENS`] || process.env.AI_DEFAULT_MAX_OUTPUT_TOKENS, 1200),
  };
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const parts = [];
  for (const item of payload.output || []) for (const content of item.content || []) if (typeof content.text === "string") parts.push(content.text);
  return parts.join("\n").trim();
}

function run(command, args, payload, timeoutMs, shell = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`AI runtime timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`AI runtime exited ${code}: ${stderr.slice(-300)}`)); });
    child.stdin.end(JSON.stringify(payload));
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function callCodexRuntime(task, config) {
  const command = process.env.CODEX_RUNTIME_COMMAND;
  const request = { task: config.purpose, model: config.model, instructions: task.instructions, input: task.input, response_contract: "Return only the requested final text or JSON. Do not run shell commands or modify files." };
  let raw;
  let outputPath = "";
  try {
    if (command) raw = await run(command, [], request, config.timeoutMs, true);
    else {
      const runtimeDir = path.join(rootDir, "logs", "ai-runtime-tmp");
      fs.mkdirSync(runtimeDir, { recursive: true });
      outputPath = path.join(runtimeDir, `response-${process.pid}-${Date.now()}.txt`);
      const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only"];
      if (config.model) args.push("--model", config.model);
      args.push("--output-last-message", outputPath);
      raw = await run(process.env.CODEX_RUNTIME_BIN || "codex", args, request, config.timeoutMs);
      for (let attempt = 0; attempt < 10 && !fs.existsSync(outputPath); attempt += 1) await wait(100);
      if (fs.existsSync(outputPath)) raw = fs.readFileSync(outputPath, "utf8").trim() || raw;
    }
  } finally {
    if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
  try { const parsed = JSON.parse(raw); return extractResponseText(parsed) ? parsed : { output_text: raw }; } catch { return { output_text: raw }; }
}

async function callOpenAiApi(task, config) {
  const apiKey = process.env.AI_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.GREETING_OPENAI_API_KEY || process.env.PROFILE_OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI_OPENAI_API_KEY or OPENAI_API_KEY is not configured");
  const baseUrl = (process.env.AI_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const model = config.model || process.env.AI_OPENAI_MODEL || "gpt-5.6";
    const response = await fetch(`${baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, signal: controller.signal, body: JSON.stringify({ model, store: false, instructions: task.instructions, input: JSON.stringify(task.input), text: { format: { type: "text" } }, max_output_tokens: config.maxOutputTokens }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed with status ${response.status}`);
    return { ...payload, output_text: extractResponseText(payload), _resolved_model: model };
  } finally { clearTimeout(timer); }
}

async function runAiTask(task) {
  const config = resolveAiConfig(task.purpose, task.options || {});
  if (!config.routes.some((route) => route.providers.length)) {
    appendAiLog({ purpose: config.purpose, status: "skipped", mode: config.mode, reason: "disabled_by_configuration" });
    return { ok: false, skipped: true, reason: `AI ${config.mode} by configuration`, config, attempts: [] };
  }
  const attempts = [];
  const attempted = new Set();
  let sequence = 0;
  for (const route of config.routes) for (const provider of route.providers) {
    const attemptKey = `${provider}:${route.model}`;
    if (attempted.has(attemptKey)) continue;
    attempted.add(attemptKey);
    const providerConfig = { ...config, mode: route.mode, model: route.model };
    const fallback = sequence++ > 0;
    try {
      const payload = await (provider === "codex_runtime" ? callCodexRuntime(task, providerConfig) : provider === "openai_api" ? callOpenAiApi(task, providerConfig) : Promise.reject(new Error(`Unsupported AI provider: ${provider}`)));
      const text = extractResponseText(payload);
      if (!text) throw new Error("AI response did not contain text");
      const model = provider === "openai_api" ? payload._resolved_model : (providerConfig.model || "codex_config_default");
      appendAiLog({ purpose: config.purpose, provider, model, status: "success", fallback, route: route.tier });
      return { ok: true, provider, model, text, payload, fallback, route: route.tier, config, attempts };
    } catch (error) {
      attempts.push({ provider, model: providerConfig.model, route: route.tier, error: error.message });
      appendAiLog({ purpose: config.purpose, provider, model: providerConfig.model, status: "failed", fallback_candidate: fallback, route: route.tier, error: error.message });
    }
  }
  return { ok: false, reason: attempts.map((item) => `${item.provider}: ${item.error}`).join("; "), config, attempts };
}

module.exports = { resolveAiConfig, runAiTask, appendAiLog };
