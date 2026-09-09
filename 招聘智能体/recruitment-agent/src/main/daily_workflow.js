const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadEnv, envBool, envNumber } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { sendRecruitmentNotification } = require("../push/outbound_sender");
const { resolveSearchStrategy } = require("../strategy/search_keyword_generator");
const { loadChannelConfig, platformEnabled, platformRuntimeEnv } = require("../core/channel_config");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const dataDir = path.join(rootDir, "data");
const outputsDir = path.join(rootDir, "outputs");
const logDir = path.join(rootDir, "logs");
const workflowLockPath = path.join(dataDir, "workflow.lock");
const today = shanghaiDateKey();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLog(message, detail = {}) {
  ensureDir(logDir);
  const entry = { at: new Date().toISOString(), message, ...detail };
  fs.appendFileSync(path.join(logDir, "daily_workflow.log"), `${JSON.stringify(entry)}\n`, "utf8");
  console.log(JSON.stringify(entry));
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readWorkflowLock() {
  try {
    return JSON.parse(fs.readFileSync(workflowLockPath, "utf8"));
  } catch {
    return null;
  }
}

function acquireWorkflowLock() {
  if (envBool("DISABLE_WORKFLOW_LOCK", false)) return { ok: true, disabled: true };
  if (process.env.WORKFLOW_LOCK_HELD) return { ok: true, inherited: true };
  ensureDir(dataDir);
  const staleMinutes = envNumber("WORKFLOW_LOCK_STALE_MINUTES", envNumber("SCHEDULE_WORKFLOW_TIMEOUT_MINUTES", 45) + 15);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    command: process.argv.join(" "),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(workflowLockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
      fs.closeSync(fd);
      return { ok: true, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readWorkflowLock();
      const ageMinutes = existing?.startedAt ? (Date.now() - new Date(existing.startedAt).getTime()) / 60000 : Infinity;
      const alive = processAlive(existing?.pid);
      if (!alive || ageMinutes > staleMinutes) {
        try { fs.unlinkSync(workflowLockPath); } catch { /* ignore stale-lock cleanup race */ }
        continue;
      }
      return {
        ok: false,
        existing: {
          pid: existing?.pid,
          startedAt: existing?.startedAt,
          ageMinutes: Number(ageMinutes.toFixed(1)),
          command: existing?.command || "",
        }
      };
    }
  }
  return { ok: false, existing: readWorkflowLock() };
}

function releaseWorkflowLock(lock) {
  if (!lock?.ok || lock.disabled || lock.inherited || !lock.token) return;
  const existing = readWorkflowLock();
  if (existing?.token !== lock.token) return;
  try { fs.unlinkSync(workflowLockPath); } catch { /* ignore */ }
}

let activeWorkflowLock = null;

function alertsSuppressed() {
  return envBool("SUPPRESS_ALERTS", false)
    || String(process.env.ALERT_SEND_MODE || "").trim().toLowerCase() === "none";
}

async function sendWorkflowAlert(text, options = {}) {
  if (alertsSuppressed()) {
    const preview = String(text || "").replace(/\s+/g, " ").slice(0, 160);
    const topic = options.topic || "recruitment_alert";
    appendLog("workflow alert suppressed", { topic, preview, reason: "SUPPRESS_ALERTS/ALERT_SEND_MODE" });
    return { skipped: true, reason: "alerts suppressed", topic };
  }
  return sendRecruitmentNotification(text, options);
}

function runNode(args, label) {
  appendLog(`${label} started`, { args });
  const result = spawnSync(process.execPath, args, { cwd: rootDir, encoding: "utf8", env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
  appendLog(`${label} finished`);
  return result.stdout;
}

function runNodeOptional(args, label) {
  try {
    const stdout = runNode(args, label);
    return { ok: true, stdout };
  } catch (error) {
    appendLog(`${label} failed but workflow will continue if another platform succeeds`, { error: error.message });
    return { ok: false, error };
  }
}

function runNodeAsync(args, label, env = process.env, options = {}) {
  appendLog(`${label} started`, { args });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: rootDir, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutKind = "";
    let timer = null;
    let idleTimer = null;
    const timeoutMs = Number(options.timeoutMs || 0);
    const idleTimeoutMs = Number(options.idleTimeoutMs || 0);
    const stopForTimeout = (kind, ms) => {
      if (timedOut) return;
      timedOut = true;
      timeoutKind = kind;
      stderr += `\n${label} ${kind} timed out after ${ms}ms`;
      try { child.kill(); } catch { /* ignore */ }
    };
    const resetIdleTimer = () => {
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || timedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stopForTimeout("idle", idleTimeoutMs), idleTimeoutMs);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => stopForTimeout("total", timeoutMs), timeoutMs);
    }
    resetIdleTimer();
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
      resetIdleTimer();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
      resetIdleTimer();
    });
    child.on("close", (status) => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (status === 0 && !timedOut) appendLog(`${label} finished`);
      else appendLog(`${label} failed`, { status, timedOut, timeoutKind, stderr: stderr.slice(-2000) });
      resolve({ ok: status === 0 && !timedOut, status, timedOut, timeoutKind, stdout, stderr });
    });
  });
}

function latestFile(pattern) {
  const files = fs
    .readdirSync(outputsDir)
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, full: path.join(outputsDir, name), mtime: fs.statSync(path.join(outputsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files[0]) throw new Error(`No matching file in ${outputsDir}: ${pattern}`);
  return files[0].full;
}

function tryLatestFile(pattern) {
  try {
    return latestFile(pattern);
  } catch {
    return "";
  }
}

function assertFreshInput(filePath, expectedDate, label) {
  if (envBool("ALLOW_STALE_INPUT", false)) return filePath;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`${label} input is missing: ${filePath || "(empty)"}`);
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const declared = payload.evaluation_date || payload.dateKey || "";
  const recordDates = [...new Set((payload.records || []).map((row) => {
    if (row.evaluation_date) return row.evaluation_date;
    if (row.collected_at) return shanghaiDateKey(new Date(row.collected_at));
    return "";
  }).filter(Boolean))];
  const fresh = declared === expectedDate || (recordDates.length > 0 && recordDates.every((date) => date === expectedDate));
  if (!fresh) throw new Error(`${label} input is not fresh for ${expectedDate}: ${filePath}. Set ALLOW_STALE_INPUT=true only for an intentional manual replay.`);
  return filePath;
}

function hasPlatformPath(paths, platform) {
  return paths.some((item) => item.platform === platform && item.path);
}

function addFreshPath(paths, platform, filePath, label) {
  if (!filePath || hasPlatformPath(paths, platform)) return false;
  paths.push({ platform, path: assertFreshInput(filePath, today, label) });
  return true;
}

function loadLatestDailyRawInputs(rawPaths, { enableBoss, enableLiepin }) {
  const suffix = today.replace(/-/g, "");
  const loaded = [];
  if (enableBoss) {
    const filePath = tryLatestFile(new RegExp(`^boss_daily_${suffix}_jobs_.*\\.json$`));
    if (addFreshPath(rawPaths, "boss", filePath, "BOSS latest raw")) {
      loaded.push({ platform: "boss", path: filePath });
    }
  }
  if (enableLiepin) {
    const filePath = tryLatestFile(new RegExp(`^liepin_daily_${suffix}_jobs_.*\\.json$`));
    if (addFreshPath(rawPaths, "liepin", filePath, "猎聘 latest raw")) {
      loaded.push({ platform: "liepin", path: filePath });
    }
  }
  appendLog("latest daily raw inputs loaded for report-only", { loaded });
  return loaded;
}

function requiredOutputPath(parsed, field, label) {
  const filePath = parsed?.[field];
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`${label} did not return a usable ${field}`);
  return filePath;
}

async function keywordSpecText() {
  const resolved = await resolveSearchStrategy();
  const config = resolved.strategy;
  const specs = [];
  for (const level of config.levels || []) {
    for (const keyword of level.keywords || []) {
      specs.push(`${level.type}::${keyword}`);
    }
  }
  return {
    perKeyword: envNumber("PER_KEYWORD", config.defaultPerKeyword || 8),
    maxTotal: envNumber("MAX_TOTAL", config.defaultMaxTotal || 50),
    specText: specs.join(","),
    ai: resolved.ai,
  };
}

function platformTimeoutMs(platform, purpose, defaultValue) {
  const platformKey = `${platform.toUpperCase()}_${purpose.toUpperCase()}_TIMEOUT_MS`;
  const sharedKey = `PLATFORM_${purpose.toUpperCase()}_TIMEOUT_MS`;
  return envNumber(platformKey, envNumber(sharedKey, defaultValue));
}

function platformIdleTimeoutMs(platform, purpose, defaultValue) {
  const platformKey = `${platform.toUpperCase()}_${purpose.toUpperCase()}_IDLE_TIMEOUT_MS`;
  const sharedKey = `PLATFORM_${purpose.toUpperCase()}_IDLE_TIMEOUT_MS`;
  const legacyKey = `PLATFORM_${purpose.toUpperCase()}_TIMEOUT_MS`;
  return envNumber(platformKey, envNumber(sharedKey, envNumber(legacyKey, defaultValue)));
}

function parseLastJson(stdout) {
  const matches = stdout.match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  try {
    return JSON.parse(matches[matches.length - 1]);
  } catch {
    return null;
  }
}

function platformLabel(platform) {
  const value = String(platform || "").toLowerCase();
  if (value === "boss") return "BOSS";
  if (value === "liepin") return "猎聘";
  return platform || "未知平台";
}

function basenameSafe(filePath) {
  if (!filePath) return "";
  try {
    return path.basename(filePath);
  } catch {
    return String(filePath);
  }
}

function loadCollectionSummary(filePath) {
  const summary = {
    file: basenameSafe(filePath),
    records: null,
    keywordErrorCount: 0,
    keywordErrorExamples: [],
    keywordErrorGroups: []
  };
  if (!filePath || !fs.existsSync(filePath)) return summary;
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const records = Array.isArray(payload.records) ? payload.records : [];
    summary.records = records.length;
    const stats = Array.isArray(payload.keywordStats) ? payload.keywordStats : [];
    const failed = stats.filter((item) => item && item.collectionError);
    summary.keywordErrorCount = failed.length;
    summary.keywordErrorExamples = failed.slice(0, 5).map((item) => item.keyword).filter(Boolean);
    const groups = new Map();
    for (const item of failed) {
      const message = String(item.collectionError || "未知错误").replace(/\s+/g, " ").trim();
      groups.set(message, (groups.get(message) || 0) + 1);
    }
    summary.keywordErrorGroups = Array.from(groups.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([message, count]) => ({ message, count }));
  } catch {
    // Alert generation must not block the workflow; the full diagnostics remain in local logs.
  }
  return summary;
}

function extractDiagnosticHints(result) {
  const text = String(result?.stderr || result?.error || "");
  const hints = [];
  const invalidJsonMatches = Array.from(text.matchAll(/BOSS job list business error:\s*invalid_json\b/gi));
  if (invalidJsonMatches.length) {
    hints.push(`BOSS 返回了非职位 JSON（${invalidJsonMatches.length}次），常见原因是访问过频触发风控/验证页、登录态临时异常、网络代理异常或接口结构变化。`);
  }
  const fetchFailedMatches = Array.from(text.matchAll(/\bfetch failed\b/gi));
  if (fetchFailedMatches.length) {
    hints.push(`浏览器内接口请求失败（${fetchFailedMatches.length}次），可能是网络/CDP 会话不稳或平台短时拒绝请求。`);
  }
  const businessMatches = Array.from(text.matchAll(/BOSS job list business error:\s*(\d+)\s*([^\r\n.。]+)/g));
  if (businessMatches.length) {
    const grouped = new Map();
    for (const match of businessMatches) {
      const key = `${match[1]} ${String(match[2] || "").replace(/\s+/g, " ").trim()}`.trim();
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }
    hints.push(`平台返回业务错误：${Array.from(grouped.entries()).map(([key, count]) => `${key}（${count}次）`).join("；")}`);
  }
  if (/账户存在异常|环境存在异常|security|verify|captcha|安全|验证/i.test(text)) {
    hints.push("可能需要先在浏览器里完成安全校验、账号验证或重新登录。");
  }
  if (/CDP command timeout|timeout|ETIMEDOUT/i.test(text)) {
    hints.push("浏览器/CDP 响应超时，可能是页面卡住、标签页失焦或浏览器连接不稳定。");
  }
  if (/login-check failed|登录态|not logged/i.test(text)) {
    hints.push("登录态校验未通过，本轮会跳过该平台，避免用旧数据生成日报。");
  }
  return Array.from(new Set(hints));
}

function collectionBlockingReason(platform, filePath, stderr) {
  let text = String(stderr || "");
  if (filePath && fs.existsSync(filePath)) {
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const stats = Array.isArray(payload.keywordStats) ? payload.keywordStats : [];
      text += `\n${stats.map((item) => item.collectionError || "").filter(Boolean).join("\n")}`;
    } catch {
      // Keep the stderr-only judgement when the partial artifact cannot be read.
    }
  }
  if (String(platform).toLowerCase() === "boss" && /BOSS job list business error:\s*(37|38)\b|请登录后使用|环境存在异常|安全验证|验证码|captcha|verify/i.test(text)) {
    return "平台登录/安全验证未通过，已阻断本平台 partial 数据进入后续流程";
  }
  if (/login_required|security_check|登录态校验失败/i.test(text)) {
    return "登录态或安全校验未通过，已阻断本平台 partial 数据进入后续流程";
  }
  return "";
}

function buildCollectionAlert(result) {
  const label = platformLabel(result.platform);
  const summary = loadCollectionSummary(result.rawPath);
  const hints = extractDiagnosticHints(result);
  const status = result.partial ? "采集部分成功" : "采集失败";
  const lines = [
    `【招聘信息智能体告警】${today} ${label} ${status}`,
    result.partial
      ? "含义：本轮已保存一部分新数据，但部分关键词、详情页或平台接口未完成；日报只会使用已确认的新鲜数据。"
      : "含义：本轮该平台没有得到可用于日报的新数据；如果其他平台成功，日报会继续发送但不包含本平台。"
  ];
  if (Number.isFinite(summary.records)) {
    lines.push(`已保存记录：${summary.records} 条${summary.file ? `（${summary.file}）` : ""}`);
  } else if (summary.file) {
    lines.push(`阶段文件：${summary.file}`);
  }
  if (summary.keywordErrorCount) {
    const examples = summary.keywordErrorExamples.length ? `，示例关键词：${summary.keywordErrorExamples.join("、")}` : "";
    lines.push(`失败关键词：${summary.keywordErrorCount} 个${examples}`);
  }
  for (const group of summary.keywordErrorGroups) {
    lines.push(`关键词错误：${group.message}（${group.count}个关键词）`);
  }
  if (hints.length) {
    lines.push(`原因判断：${hints.join(" ")}`);
  } else if (result.error) {
    lines.push(`原因判断：${result.error}`);
  }
  lines.push(result.partial
    ? "影响：本轮不是卡死；但本平台数据可能不完整，部分岗位不会进入当日报告。"
    : "影响：本轮已跳过该平台，避免旧数据混入报告。");
  lines.push(label === "BOSS"
    ? "建议：完成 BOSS 页面安全校验/登录后，手动重跑一次采集或等待下一轮；如仍反复出现，请降低关键词频率或检查浏览器/CDP。"
    : "建议：检查平台登录态和本地日志后，手动重跑一次采集或等待下一轮。");
  lines.push("本地日志：logs/daily_workflow.log");
  return lines.join("\n");
}

async function main() {
  activeWorkflowLock = acquireWorkflowLock();
  if (!activeWorkflowLock.ok) {
    appendLog("workflow skipped because another run is active", { lock: activeWorkflowLock.existing });
    console.log(JSON.stringify({ type: "workflow_result", status: "skipped_locked", reason: "another workflow is running", lock: activeWorkflowLock.existing }));
    process.exitCode = 3;
    return;
  }
  ensureDir(outputsDir);
  appendLog("workflow started", { today });
  const channelResult = loadChannelConfig();
  const channelConfig = channelResult.config;
  const enableBoss = platformEnabled(channelConfig, "boss");
  const enableLiepin = platformEnabled(channelConfig, "liepin");
  appendLog("platform channel configuration loaded", {
    filePath: channelResult.filePath,
    boss: channelConfig.platforms.boss,
    liepin: channelConfig.platforms.liepin,
  });
  const rawPaths = [];
  const screenedPaths = [];
  const evaluatedPaths = [];
  const partialPlatforms = [];
  const failedPlatforms = [];
  if (enableBoss && process.env.INPUT_RAW_JSON) rawPaths.push({ platform: "boss", path: assertFreshInput(process.env.INPUT_RAW_JSON, today, "BOSS raw") });
  if (enableLiepin && process.env.INPUT_LIEPIN_RAW_JSON) rawPaths.push({ platform: "liepin", path: assertFreshInput(process.env.INPUT_LIEPIN_RAW_JSON, today, "猎聘 raw") });
  if (enableBoss && process.env.INPUT_SCREENED_JSON) screenedPaths.push({ platform: "boss", path: assertFreshInput(process.env.INPUT_SCREENED_JSON, today, "BOSS screened") });
  if (enableLiepin && process.env.INPUT_LIEPIN_SCREENED_JSON) screenedPaths.push({ platform: "liepin", path: assertFreshInput(process.env.INPUT_LIEPIN_SCREENED_JSON, today, "猎聘 screened") });
  if (enableBoss && process.env.INPUT_EVALUATED_JSON) evaluatedPaths.push({ platform: "boss", path: assertFreshInput(process.env.INPUT_EVALUATED_JSON, today, "BOSS evaluated") });
  if (enableLiepin && process.env.INPUT_LIEPIN_EVALUATED_JSON) evaluatedPaths.push({ platform: "liepin", path: assertFreshInput(process.env.INPUT_LIEPIN_EVALUATED_JSON, today, "猎聘 evaluated") });

  const collectEnabled = envBool("ENABLE_COLLECT", true);
  const screenEnabled = envBool("ENABLE_SCREEN", true);
  const evaluateEnabled = envBool("ENABLE_EVALUATE", true);
  const pushEnabled = envBool("ENABLE_PUSH", true);
  if (!collectEnabled && !screenEnabled && !evaluateEnabled && !pushEnabled) {
    throw new Error("No workflow stages are enabled. Enable at least one of ENABLE_COLLECT, ENABLE_SCREEN, ENABLE_EVALUATE, or ENABLE_PUSH.");
  }
  if (!collectEnabled) {
    loadLatestDailyRawInputs(rawPaths, { enableBoss, enableLiepin });
    if (!rawPaths.length && !screenedPaths.length && !evaluatedPaths.length) {
      throw new Error("No fresh input is available for the requested workflow stages. Run collection first or provide a same-day input file.");
    }
  }

  if (collectEnabled) {
    const strategy = await keywordSpecText();
    appendLog("search keyword strategy resolved", strategy.ai);
    const stageName = `daily_${today.replace(/-/g, "")}`;
    const tasks = [];
    const loginCheckTimeoutMs = envNumber("LOGIN_CHECK_TIMEOUT_MS", envNumber("BOSS_LOGIN_CHECK_TIMEOUT_MS", 90000));
    const bossCollectIdleTimeoutMs = platformIdleTimeoutMs("BOSS", "COLLECT", 300000);
    const liepinCollectIdleTimeoutMs = platformIdleTimeoutMs("LIEPIN", "COLLECT", 300000);
    const bossCollectTotalTimeoutMs = platformTimeoutMs("BOSS", "COLLECT_TOTAL", 900000);
    const liepinCollectTotalTimeoutMs = platformTimeoutMs("LIEPIN", "COLLECT_TOTAL", 900000);
    if (enableBoss) {
      tasks.push(async () => {
        const bossEnv = platformRuntimeEnv(channelConfig, "boss");
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/boss/check_boss_login_status.js"], "boss-login-check", bossEnv, { timeoutMs: loginCheckTimeoutMs });
          if (!login.ok) return { platform: "boss", ok: false, error: login.timedOut ? "登录态校验超时" : "登录态校验失败", stderr: String(login.stderr || "").slice(-4000) };
        }
        const collect = await runNodeAsync(["src/platforms/boss/boss_batch_collect.js", stageName, String(strategy.perKeyword), String(strategy.maxTotal), strategy.specText], "boss-collect", bossEnv, { idleTimeoutMs: bossCollectIdleTimeoutMs, timeoutMs: bossCollectTotalTimeoutMs });
        if (!collect.ok) {
          const partialPath = tryLatestFile(new RegExp(`^boss_${stageName}_jobs_.*\\.json$`));
          const blockingReason = collectionBlockingReason("boss", partialPath, collect.stderr);
          if (blockingReason) return { platform: "boss", ok: false, rawPath: partialPath, error: blockingReason, stderr: String(collect.stderr || "").slice(-4000) };
          if (partialPath) return { platform: "boss", ok: true, partial: true, rawPath: partialPath, error: collect.timedOut ? `采集${collect.timeoutKind === "idle" ? "空闲" : "总时长"}超时，仅保留超时前已完成数据` : "采集部分完成，部分关键词失败", timedOut: collect.timedOut, timeoutKind: collect.timeoutKind, stderr: String(collect.stderr || "").slice(-4000) };
          return { platform: "boss", ok: false, error: collect.timedOut ? `采集${collect.timeoutKind === "idle" ? "空闲" : "总时长"}超时` : "采集进程失败", timedOut: collect.timedOut, timeoutKind: collect.timeoutKind, stderr: String(collect.stderr || "").slice(-4000) };
        }
        return { platform: "boss", ok: true, rawPath: latestFile(new RegExp(`^boss_${stageName}_jobs_.*\\.json$`)) };
      });
    }
    if (enableLiepin) {
      tasks.push(async () => {
        const liepinEnv = platformRuntimeEnv(channelConfig, "liepin");
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/liepin/check_liepin_login_status.js"], "liepin-login-check", liepinEnv, { timeoutMs: loginCheckTimeoutMs });
          if (!login.ok) return { platform: "liepin", ok: false, error: login.timedOut ? "登录态校验超时" : "登录态校验失败", stderr: String(login.stderr || "").slice(-4000) };
        }
        const per = envNumber("LIEPIN_PER_KEYWORD", envNumber("PER_KEYWORD", strategy.perKeyword));
        const max = envNumber("LIEPIN_MAX_TOTAL", envNumber("MAX_TOTAL", strategy.maxTotal));
        const collect = await runNodeAsync(["src/platforms/liepin/liepin_batch_collect.js", stageName, String(per), String(max), strategy.specText], "liepin-collect", liepinEnv, { idleTimeoutMs: liepinCollectIdleTimeoutMs, timeoutMs: liepinCollectTotalTimeoutMs });
        if (!collect.ok) {
          const partialPath = tryLatestFile(new RegExp(`^liepin_${stageName}_jobs_.*\\.json$`));
          if (partialPath) return { platform: "liepin", ok: true, partial: true, rawPath: partialPath, error: collect.timedOut ? `采集${collect.timeoutKind === "idle" ? "空闲" : "总时长"}超时，仅保留超时前已完成数据` : "采集部分完成，部分关键词失败", timedOut: collect.timedOut, timeoutKind: collect.timeoutKind, stderr: String(collect.stderr || "").slice(-4000) };
          return { platform: "liepin", ok: false, error: collect.timedOut ? `采集${collect.timeoutKind === "idle" ? "空闲" : "总时长"}超时` : "采集进程失败", timedOut: collect.timedOut, timeoutKind: collect.timeoutKind, stderr: String(collect.stderr || "").slice(-4000) };
        }
        return { platform: "liepin", ok: true, rawPath: latestFile(new RegExp(`^liepin_${stageName}_jobs_.*\\.json$`)) };
      });
    }
    const results = [];
    appendLog("platform collection mode", { mode: "sequential", reason: "shared Chrome CDP session" });
    for (const task of tasks) {
      results.push(await task());
    }
    for (const result of results) {
      appendLog("platform collect result", result);
      if (result.ok && result.rawPath) rawPaths.push({ platform: result.platform, path: result.rawPath });
      if (!result.ok || result.partial) {
        if (!result.ok) failedPlatforms.push(result.platform);
        if (result.partial) partialPlatforms.push(result.platform);
        const level = result.partial ? "部分成功" : "失败";
        try {
          const alert = await sendWorkflowAlert(buildCollectionAlert(result), { topic: "recruitment_alert" });
          appendLog("platform collection alert attempted", { platform: result.platform, partial: Boolean(result.partial), alert });
        } catch (alertError) {
          appendLog("platform collection alert failed", { platform: result.platform, error: alertError.message });
        }
      }
    }
    if (!rawPaths.length) throw new Error("No platform collection succeeded");
  }
  if (screenEnabled) {
    if (enableBoss) {
      const input = rawPaths.find((item) => item.platform === "boss")?.path;
      if (!input) appendLog("boss-screen skipped", { reason: "no boss raw file" });
      else {
      const result = runNodeOptional(["src/platforms/boss/postprocess_boss_stage2.js", input, today], "boss-screen");
      const parsed = result.ok ? parseLastJson(result.stdout) : null;
      if (result.ok) screenedPaths.push({ platform: "boss", path: requiredOutputPath(parsed, "jsonPath", "boss-screen") });
      }
    }
    if (enableLiepin) {
      const input = rawPaths.find((item) => item.platform === "liepin")?.path;
      if (!input) appendLog("liepin-screen skipped", { reason: "no liepin raw file" });
      else {
      const result = runNodeOptional(["src/platforms/liepin/postprocess_liepin_stage2.js", input, today], "liepin-screen");
      const parsed = result.ok ? parseLastJson(result.stdout) : null;
      if (result.ok) screenedPaths.push({ platform: "liepin", path: requiredOutputPath(parsed, "jsonPath", "liepin-screen") });
      }
    }
  }
  if (evaluateEnabled) {
    if (enableBoss) {
      const input = screenedPaths.find((item) => item.platform === "boss")?.path;
      if (!input) appendLog("boss-evaluate skipped", { reason: "no boss screened file" });
      else {
      const result = runNodeOptional(["src/evaluate/evaluate_job_fit.js", input, today, "boss_stage3_fit_evaluated"], "boss-evaluate");
      const parsed = result.ok ? parseLastJson(result.stdout) : null;
      if (result.ok) evaluatedPaths.push({ platform: "boss", path: requiredOutputPath(parsed, "outJson", "boss-evaluate") });
      }
    }
    if (enableLiepin) {
      const input = screenedPaths.find((item) => item.platform === "liepin")?.path;
      if (!input) appendLog("liepin-evaluate skipped", { reason: "no liepin screened file" });
      else {
      const result = runNodeOptional(["src/evaluate/evaluate_job_fit.js", input, today, "liepin_stage3_fit_evaluated"], "liepin-evaluate");
      const parsed = result.ok ? parseLastJson(result.stdout) : null;
      if (result.ok) evaluatedPaths.push({ platform: "liepin", path: requiredOutputPath(parsed, "outJson", "liepin-evaluate") });
      }
    }
  }
  if (envBool("ENABLE_JOB_STORE", true) && evaluatedPaths.length) {
    const args = ["src/store/job_store_update.js", "upsert", ...evaluatedPaths.map((item) => item.path), `--date=${today}`];
    const result = runNodeOptional(args, "job-store-upsert");
    const parsed = result.ok ? parseLastJson(result.stdout) : null;
    if (parsed?.trackedFiles?.length) {
      evaluatedPaths.length = 0;
      for (const file of parsed.trackedFiles) {
        evaluatedPaths.push({ platform: file.platform, path: file.jsonPath });
      }
    }
  }
  if (pushEnabled) {
    if (!evaluatedPaths.length) throw new Error("No evaluated files available for push");
    const args = ["src/push/job_push_draft_and_send.js", ...evaluatedPaths.map((item) => item.path)];
    if (process.env.SEND_MODE === "send") args.push("--send");
    runNode(args, "draft-or-send");
  }
  if (envBool("ENABLE_JOB_STORE", true) && envBool("ENABLE_STATUS_REFRESH", true) && evaluatedPaths.length) {
    for (const item of evaluatedPaths) {
      const args = ["src/store/job_store_update.js", "refresh", item.path, `--date=${today}`, `--platform=${item.platform}`];
      runNodeOptional(args, `job-store-refresh-${item.platform}`);
    }
  }
  const workflowStatus = partialPlatforms.length || failedPlatforms.length ? "partial_success" : "success";
  appendLog("workflow finished", { workflowStatus, partialPlatforms, failedPlatforms, rawPaths, screenedPaths, evaluatedPaths });
  console.log(JSON.stringify({ type: "workflow_result", status: workflowStatus, partialPlatforms, failedPlatforms, rawPaths, screenedPaths, evaluatedPaths }));
  if (partialPlatforms.length || failedPlatforms.length) process.exitCode = 2;
  releaseWorkflowLock(activeWorkflowLock);
  activeWorkflowLock = null;
}

main().catch(async (error) => {
  appendLog("workflow failed", { error: error.stack || error.message });
  try {
    const alert = await sendWorkflowAlert(`【招聘信息智能体告警】${today} 流程运行失败：${error.message}`, { topic: "recruitment_alert" });
    appendLog("failure alert attempted", { delivered: Boolean(alert?.status >= 200 && alert?.status < 300), result: alert });
  } catch (alertError) {
    appendLog("failure alert failed", { error: alertError.message });
  }
  process.exitCode = 1;
}).finally(() => {
  releaseWorkflowLock(activeWorkflowLock);
  activeWorkflowLock = null;
});
