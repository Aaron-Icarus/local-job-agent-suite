const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..", "..");

function numberValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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
  // Do not write prompts, resumes, JD text, API keys, or model responses to the audit log.
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

// Streaming progress of a single AI run lands in logs/ai_runtime/<purpose>_<ts>.log,
// so a long-running model call stays observable and diagnosable without touching
// the audit log or blocking anything else.
function streamLogPath(purpose) {
  const dir = path.join(rootDir, "logs", "ai_runtime");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${String(purpose || "default").replace(/[^a-z0-9]+/gi, "_")}_${stamp}.log`);
}

function appendStreamFile(filePath, text) {
  try { fs.appendFileSync(filePath, text, "utf8"); } catch { /* progress logging must never break the call */ }
}

function resolveAiConfig(purpose, overrides = {}) {
  const key = purposeKey(purpose);
  const legacy = key === "GREETING" ? "GREETING" : key === "PROFILE" ? "PROFILE" : "";
  const defaultMode = process.env.AI_DEFAULT_MODE || "auto";
  const configuredMode = overrides.mode || process.env[`AI_${key}_MODE`] || (legacy && process.env[`${legacy}_MODE`]);
  const requestedMode = configuredMode || defaultMode;
  const defaultProviders = splitList(process.env.AI_DEFAULT_PROVIDER_ORDER, "codex_runtime,openai_api");
  const configuredProviderValue = overrides.provider_order || process.env[`AI_${key}_PROVIDER_ORDER`] || (legacy && process.env[`${legacy}_AI_PROVIDER_ORDER`]) || "";
  const requestedProviders = splitList(configuredProviderValue, "");
  const configuredModel = overrides.model || process.env[`AI_${key}_MODEL`] || (legacy && process.env[`${legacy}_OPENAI_MODEL`]) || "";
  const defaultModel = process.env.AI_DEFAULT_MODEL || process.env.OPENAI_MODEL || "";
  const defaultRoute = {
    tier: "default",
    mode: String(defaultMode || "auto").toLowerCase(),
    providers: providerListForMode(defaultMode, [], defaultProviders),
    model: defaultModel,
  };
  const hasStepRoute = Boolean(configuredMode || configuredProviderValue || configuredModel || overrides.mode || overrides.provider_order || overrides.model);
  const stepRoute = hasStepRoute ? {
    tier: "step",
    mode: String(requestedMode || "auto").toLowerCase(),
    providers: providerListForMode(requestedMode, requestedProviders, defaultProviders),
    model: configuredModel || defaultModel,
  } : null;
  const routes = stepRoute ? [stepRoute, defaultRoute] : [defaultRoute];
  // Handshake window: how long we wait for the model process to *start producing output*
  // before we give up and kill it. Keeps the old AI_DEFAULT_TIMEOUT_MS behaviour by default.
  const handshakeTimeoutMs = numberValue(
    overrides.handshake_timeout_ms ||
    process.env[`AI_${key}_HANDSHAKE_TIMEOUT_MS`] ||
    process.env.AI_DEFAULT_HANDSHAKE_TIMEOUT_MS ||
    process.env.AI_DEFAULT_TIMEOUT_MS,
    90000
  );
  // Overall budget once the run has started. Default 30 minutes so a model that is
  // genuinely working is never cut off by a fixed short timeout.
  const totalTimeoutMs = numberValue(
    overrides.total_timeout_ms ||
    process.env[`AI_${key}_TOTAL_TIMEOUT_MS`] ||
    process.env.AI_DEFAULT_TOTAL_TIMEOUT_MS,
    1800000
  );
  return {
    purpose,
    key,
    mode: String(requestedMode || "auto").toLowerCase(),
    providers: routes.flatMap((route) => route.providers),
    model: stepRoute?.model || defaultModel,
    routes,
    handshakeTimeoutMs,
    totalTimeoutMs,
    timeoutMs: handshakeTimeoutMs, // legacy alias used by callers that read timeoutMs
    maxOutputTokens: numberValue(overrides.max_output_tokens || process.env[`AI_${key}_MAX_OUTPUT_TOKENS`] || process.env.AI_DEFAULT_MAX_OUTPUT_TOKENS, 1200),
  };
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) if (typeof content.text === "string") parts.push(content.text);
  }
  return parts.join("\n").trim();
}

// Final text from Codex JSONL events (codex exec --json). The last "result" event
// carries the final answer; assistant message text is the fallback.
function extractCodexJsonlText(stdout) {
  let lastResultText = "";
  let lastMessageText = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const type = event.type || "";
    const payload = event.payload || {};
    if (type === "result" && typeof payload.result === "string" && payload.result.trim()) {
      lastResultText = payload.result.trim();
    }
    if (type === "agent_message") {
      const textParts = [];
      for (const item of payload.content || []) {
        if (typeof item.text === "string") textParts.push(item.text);
        else if (typeof item === "string") textParts.push(item);
      }
      const text = textParts.join("").trim();
      if (text) lastMessageText = text;
    }
  }
  return lastResultText || lastMessageText;
}

function collectTextFromPayload(payload) {
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) if (typeof content.text === "string") parts.push(content.text);
  }
  return parts.join("\n").trim();
}

// Spawns `command args`, feeds `input` on stdin, and streams stdout/stderr to the
// per-run progress file. Returns once the process exits.
//  - handshakeMs: if nothing is produced within this window the process is killed
//    (the model never started).
//  - totalMs: overall budget applied AFTER the handshake succeeded; long runs are
//    allowed up to this cap while progress keeps flowing.
//  - onProgress: optional callback receiving every text chunk (streaming visibility).
function runProcessStreaming(command, args, input, { handshakeMs, totalMs, streamFile, onProgress = null }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let started = false;
    let finished = false;
    let startMark = null;
    let handshakeTimer = null;
    let totalTimer = null;
    let heartbeatTimer = null;
    let lastActivity = Date.now();
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(handshakeTimer);
      clearTimeout(totalTimer);
      clearInterval(heartbeatTimer);
    };
    const markStarted = (channel) => {
      if (started || finished) return;
      started = true;
      startMark = Date.now();
      clearTimeout(handshakeTimer);
      appendStreamFile(streamFile, `\n[ai][${new Date().toISOString()}] ${channel} started producing output; handshake ok (within ${handshakeMs}ms)\n`);
      appendAiLog({ purpose: "codex_runtime_call", provider: "codex_runtime", status: "started", handshake_timeout_ms: handshakeMs, note: `first ${channel} output received` });
      if (totalMs > 0) {
        totalTimer = setTimeout(() => {
          if (finished) return;
          try { child.kill(); } catch { /* ignore */ }
          const message = `Codex runtime exceeded overall limit of ${totalMs}ms after it had started`;
          appendStreamFile(streamFile, `\n[ai] ${message}\n`);
          reject(new Error(message));
        }, totalMs);
      }
      heartbeatTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivity;
        if (idleMs >= 30000) {
          appendStreamFile(streamFile, `\n[ai] still running (idle ${Math.round(idleMs / 1000)}s since last output)\n`);
        }
      }, 30000);
    };
    handshakeTimer = setTimeout(() => {
      if (finished || started) return;
      try { child.kill(); } catch { /* ignore */ }
      const message = `Codex runtime handshake timeout: no output within ${handshakeMs}ms (assumed not started, killed)`;
      appendStreamFile(streamFile, `\n[ai] ${message}\n`);
      reject(new Error(message));
    }, handshakeMs);
    child.stdout.on("data", (chunk) => {
      lastActivity = Date.now();
      if (!started) markStarted("stdout");
      const text = chunk.toString();
      stdout += text;
      appendStreamFile(streamFile, text);
      if (onProgress) onProgress(text);
    });
    child.stderr.on("data", (chunk) => {
      lastActivity = Date.now();
      if (!started) markStarted("stderr");
      const text = chunk.toString();
      stderr += text;
      appendStreamFile(streamFile, `[stderr] ${text}`);
    });
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("close", (code) => {
      finish();
      if (code !== 0) {
        const message = `Codex runtime exited ${code}: ${String(stderr || "").slice(-300)}`;
        appendStreamFile(streamFile, `\n[ai] ${message}\n`);
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
    try {
      child.stdin.end(JSON.stringify(input));
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

async function callCodexRuntime(task, config) {
  const command = process.env.CODEX_RUNTIME_COMMAND;
  const request = { task: config.purpose, model: config.model, instructions: task.instructions, input: task.input, response_contract: "Return only the requested final text or JSON. Do not run shell commands or modify files." };
  const codexArgs = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json"];
  if (config.model) codexArgs.push("--model", config.model);
  let outputPath = "";
  if (!command) {
    const runtimeDir = path.join(rootDir, "logs", "ai-runtime-tmp");
    fs.mkdirSync(runtimeDir, { recursive: true });
    outputPath = path.join(runtimeDir, `response-${process.pid}-${Date.now()}.txt`);
    codexArgs.push("--output-last-message", outputPath);
  }
  const streamFile = streamLogPath(config.purpose);
  const startedAt = Date.now();
  let raw = "";
  try {
    const result = command
      ? await runProcessStreaming(command, [], request, { handshakeMs: config.handshakeTimeoutMs, totalMs: config.totalTimeoutMs, streamFile })
      : await runProcessStreaming(process.env.CODEX_RUNTIME_BIN || "codex", codexArgs, request, { handshakeMs: config.handshakeTimeoutMs, totalMs: config.totalTimeoutMs, streamFile });
    raw = result.stdout;
    if (outputPath) {
      for (let attempt = 0; attempt < 10 && !fs.existsSync(outputPath); attempt += 1) await wait(100);
      if (fs.existsSync(outputPath)) {
        const fileText = fs.readFileSync(outputPath, "utf8").trim();
        if (fileText) raw = fileText;
      }
    }
  } finally {
    if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
  // Prefer a structured final answer from Codex JSONL events when available.
  const jsonlText = extractCodexJsonlText(raw);
  if (jsonlText) {
    appendStreamFile(streamFile, `\n[ai] final(answer-from-events) duration_ms=${Date.now() - startedAt}\n`);
    return { output_text: jsonlText };
  }
  try {
    const parsed = JSON.parse(raw);
    const text = collectTextFromPayload(parsed);
    return text ? { ...parsed, output_text: text } : { output_text: raw };
  } catch { return { output_text: raw }; }
}

async function callOpenAiApi(task, config) {
  const apiKey = process.env.AI_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.GREETING_OPENAI_API_KEY || process.env.PROFILE_OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI_OPENAI_API_KEY or OPENAI_API_KEY is not configured");
  const baseUrl = (process.env.AI_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || process.env.GREETING_OPENAI_BASE_URL || process.env.PROFILE_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  // Total budget for the whole request once it has started; short per-attempt
  // timeouts are not applied because the API call is already in flight.
  const totalTimer = setTimeout(() => controller.abort(), config.totalTimeoutMs || 1800000);
  const streamFile = streamLogPath(config.purpose);
  try {
    const model = config.model || process.env.AI_OPENAI_MODEL || "gpt-5.6";
    appendStreamFile(streamFile, `[ai] openai request started model=${model}\n`);
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ model, store: false, instructions: task.instructions, input: JSON.stringify(task.input), text: { format: { type: "text" } }, max_output_tokens: config.maxOutputTokens }),
    });
    appendStreamFile(streamFile, `[ai] openai response headers received status=${response.status} (handshake ok)\n`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed with status ${response.status}`);
    return { ...payload, output_text: extractResponseText(payload), _resolved_model: model };
  } catch (error) {
    if (error && error.name === "AbortError") {
      const message = `OpenAI request exceeded overall limit of ${config.totalTimeoutMs || 1800000}ms`;
      appendStreamFile(streamFile, `\n[ai] ${message}\n`);
      throw new Error(message);
    }
    throw error;
  } finally { clearTimeout(totalTimer); }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  for (const route of config.routes) {
    for (const provider of route.providers) {
      const attemptKey = `${provider}:${route.model}`;
      if (attempted.has(attemptKey)) continue;
      attempted.add(attemptKey);
      const providerConfig = { ...config, mode: route.mode, model: route.model };
      const fallback = sequence > 0;
      sequence += 1;
      try {
        const startedAt = Date.now();
        const payload = await (provider === "codex_runtime" ? callCodexRuntime(task, providerConfig)
          : provider === "openai_api" ? callOpenAiApi(task, providerConfig)
            : Promise.reject(new Error(`Unsupported AI provider: ${provider}`)));
        const text = extractResponseText(payload);
        if (!text) throw new Error("AI response did not contain text");
        const resolvedModel = provider === "openai_api" ? payload._resolved_model : (providerConfig.model || "codex_config_default");
        appendAiLog({ purpose: config.purpose, provider, model: resolvedModel, status: "success", fallback, route: route.tier, duration_ms: Date.now() - startedAt });
        return { ok: true, provider, model: resolvedModel, text, payload, fallback, route: route.tier, config, attempts };
      } catch (error) {
        const attempt = { provider, model: providerConfig.model, route: route.tier, error: error.message };
        attempts.push(attempt);
        appendAiLog({ purpose: config.purpose, provider, model: providerConfig.model, status: "failed", fallback_candidate: fallback, route: route.tier, error: error.message });
      }
    }
  }
  return { ok: false, reason: attempts.map((item) => `${item.provider}: ${item.error}`).join("; "), config, attempts };
}

module.exports = { resolveAiConfig, runAiTask, appendAiLog };
