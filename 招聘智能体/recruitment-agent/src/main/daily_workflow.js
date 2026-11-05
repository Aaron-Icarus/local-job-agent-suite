const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadEnv, envBool, envNumber } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { sendRecruitmentNotification } = require("../push/outbound_sender");
const { resolveSearchStrategy } = require("../strategy/search_keyword_generator");
const { planKeywords, loadProfiles, rebuildProfilesFromLedger } = require("../strategy/keyword_planner");
const { loadChannelConfig, platformEnabled, platformRuntimeEnv } = require("../core/channel_config");
const { closeCollectTabs } = require("../core/cdp_common");
const { readLedger, mergeDay, writeDailySummary, writeDailyJson, pruneLedger } = require("../store/collection_ledger");
const { writeJsonAtomic } = require("../core/atomic_json");

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

function strategySpecText(strategy) {
  const specs = [];
  for (const level of strategy.levels || []) {
    for (const keyword of level.keywords || []) {
      specs.push(`${level.type}::${keyword}`);
    }
  }
  return specs.join(",");
}

// v1.3：把“匹配度 + 历史新增 + 久未使用 + 重复/失败”滚动排序后，给每个词分配目标新增和最大页数。
// 这样前几个词不会一次吃满总配额，后面的词也有机会被轮到。
function buildKeywordPlan(strategy, channels, dateKey) {
  const profiles = loadProfiles();
  const channelsPlan = {};
  for (const platform of channels) {
    const key = platform === "liepin" ? "liepin" : "boss";
    const prefix = key.toUpperCase();
    const totalNew = envNumber(`${prefix}_TARGET_NEW`, envNumber("COLLECT_TARGET_NEW", 30));
    const perKeywordMax = envNumber(`${prefix}_MAX_NEW_PER_KEYWORD`, envNumber("KEYWORD_MAX_NEW", 8));
    const maxPages = envNumber(`${prefix}_MAX_PAGES`, envNumber("KEYWORD_MAX_PAGES", 3));
    const maxQueue = envNumber("KEYWORD_MAX_PER_ROUND", 12);
    channelsPlan[key] = planKeywords({
      levels: strategy.levels || [],
      channel: key,
      totalNew,
      perKeywordMax,
      maxPages,
      maxQueue,
      profiles,
      nowDate: dateKey,
    });
  }
  const filePath = path.join(outputsDir, `keyword_plan_${dateKey.replace(/-/g, "")}_${Date.now()}.json`);
  writeJsonAtomic(filePath, { date: dateKey, channels: channelsPlan });
  return { filePath, channelsPlan };
}

function fileRecordCount(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(payload.records) ? payload.records.length : 0;
  } catch {
    return 0;
  }
}

function keywordErrorCount(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return (payload.keywordStats || []).filter((item) => item && item.collectionError).length;
  } catch {
    return 0;
  }
}

function setPlatformStatus(statuses, platform, status) {
  const rank = { success: 0, partial_success: 1, failed: 2 };
  const previous = statuses[platform] || "success";
  if ((rank[status] ?? 0) >= (rank[previous] ?? 0)) statuses[platform] = status;
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
  const text = String(stdout || "").trim();
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  let start = text.lastIndexOf("{", end);
  while (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 继续往前找外层的 '{'
    }
    start = start > 0 ? text.lastIndexOf("{", start - 1) : -1;
  }
  return null;
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
  if (/风控降级|整轮缺失/.test(text)) {
    hints.push("平台疑似对本机环境做了风控降级：仍能返回职位列表，但薪资等结构化字段被抹掉，本轮数据的薪资维度不可信。");
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

// 采集平台白名单解析：调度器按渠道独立判断后会通过 COLLECT_PLATFORMS 传入本轮待采平台。
// 为空表示保持旧行为——采集全部启用平台；否则只采集清单内的平台，避免把"已经成功采集过"
// 的平台在每个整点重复采集（2026-09-30 BOSS 因此被采 9 轮，触发平台风控降级）。
function resolveCollectPlatforms(env, enabled) {
  const requested = String((env && env.COLLECT_PLATFORMS) || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const wanted = (name) => requested.length === 0 || requested.includes(name);
  return {
    requested,
    boss: Boolean(enabled && enabled.boss) && wanted("boss"),
    liepin: Boolean(enabled && enabled.liepin) && wanted("liepin"),
  };
}

// 采集质量闸门：平台风控降级时仍会返回 code:0 + 职位列表，但会把薪资等结构化字段整轮抹掉。
// 这种"能跑完但字段全空"的数据必须显式降级并告警，否则会静默产出"可关注 0 条"的空日报
// （2026-09-30 / 2026-10-01 BOSS 就是这么连续空了两次）。
const SALARY_WIPE_MIN_RECORDS = 5;
const SALARY_WIPE_RATIO = 0.2;

function assessCollectionQuality(platform, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (records.length < SALARY_WIPE_MIN_RECORDS) return null;
    const withSalary = records.filter((row) => {
      const text = `${row.salary ?? ""}${row.salary_min_k ?? ""}${row.salary_max_k ?? ""}`.trim();
      return text !== "";
    }).length;
    const ratio = withSalary / records.length;
    if (ratio >= SALARY_WIPE_RATIO) return null;
    return {
      platform,
      degraded: true,
      records: records.length,
      salaryCoverage: Number(ratio.toFixed(3)),
      reason: `本轮薪资字段几乎整轮缺失（${withSalary}/${records.length} 条有薪资），疑似平台风控降级：接口仍返回职位列表但抹掉了结构化字段`
    };
  } catch {
    // 质量判定失败绝不阻断主流程，完整诊断仍留在本地日志。
    return null;
  }
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
  const ingestedPaths = [];
  const scoredPaths = [];
  const collectResults = [];
  const platformStatuses = {};
  const addPathOnce = (list, platform, filePath) => {
    if (!filePath || list.some((item) => item.platform === platform)) return;
    list.push({ platform, path: filePath });
  };

  if (enableBoss && process.env.INPUT_RAW_JSON) addPathOnce(rawPaths, "boss", assertFreshInput(process.env.INPUT_RAW_JSON, today, "BOSS raw"));
  if (enableLiepin && process.env.INPUT_LIEPIN_RAW_JSON) addPathOnce(rawPaths, "liepin", assertFreshInput(process.env.INPUT_LIEPIN_RAW_JSON, today, "猎聘 raw"));
  // 兼容旧变量名：旧的“screened/evaluated”在这个版本分别对应“已入库/已评分”。
  if (enableBoss && process.env.INPUT_INGESTED_JSON) addPathOnce(ingestedPaths, "boss", assertFreshInput(process.env.INPUT_INGESTED_JSON, today, "BOSS ingested"));
  if (enableLiepin && process.env.INPUT_LIEPIN_INGESTED_JSON) addPathOnce(ingestedPaths, "liepin", assertFreshInput(process.env.INPUT_LIEPIN_INGESTED_JSON, today, "猎聘 ingested"));
  if (enableBoss && process.env.INPUT_SCORED_JSON) addPathOnce(scoredPaths, "boss", assertFreshInput(process.env.INPUT_SCORED_JSON, today, "BOSS scored"));
  if (enableLiepin && process.env.INPUT_LIEPIN_SCORED_JSON) addPathOnce(scoredPaths, "liepin", assertFreshInput(process.env.INPUT_LIEPIN_SCORED_JSON, today, "猎聘 scored"));

  const collectEnabled = envBool("ENABLE_COLLECT", true);
  const ingestEnabled = envBool("ENABLE_INGEST", envBool("ENABLE_SCREEN", true));
  const scoreEnabled = envBool("ENABLE_SCORE", envBool("ENABLE_EVALUATE", true));
  const pushEnabled = envBool("ENABLE_PUSH", true);
  if (!collectEnabled && !ingestEnabled && !scoreEnabled && !pushEnabled) {
    throw new Error("No workflow stages are enabled. Enable at least one of ENABLE_COLLECT, ENABLE_INGEST, ENABLE_SCORE, or ENABLE_PUSH.");
  }
  if (!collectEnabled && !rawPaths.length && !ingestedPaths.length && !scoredPaths.length) {
    loadLatestDailyRawInputs(rawPaths, { enableBoss, enableLiepin });
  }
  if (!collectEnabled && !rawPaths.length && !ingestedPaths.length && !scoredPaths.length) {
    throw new Error("No fresh input is available for the requested workflow stages. Run collection first or provide a same-day input file.");
  }

  let keywordPlan = null;
  if (collectEnabled) {
    const { requested: collectOnly, boss: collectBoss, liepin: collectLiepin } =
      resolveCollectPlatforms(process.env, { boss: enableBoss, liepin: enableLiepin });
    appendLog("collection platform filter resolved", {
      requested: collectOnly,
      boss: collectBoss,
      liepin: collectLiepin,
    });
    const resolved = await resolveSearchStrategy();
    const strategy = resolved.strategy;
    appendLog("search keyword strategy resolved", resolved.ai);
    const planChannels = [collectBoss ? "boss" : "", collectLiepin ? "liepin" : ""].filter(Boolean);
    try {
      keywordPlan = buildKeywordPlan(strategy, planChannels, today);
      appendLog("keyword plan generated", {
        path: keywordPlan.filePath,
        channels: Object.fromEntries(Object.entries(keywordPlan.channelsPlan).map(([key, items]) => [key, items.length])),
      });
    } catch (planError) {
      appendLog("keyword plan failed; fallback to static order", { error: planError.message });
      keywordPlan = null;
    }
    const perKeyword = envNumber("PER_KEYWORD", strategy.defaultPerKeyword || 8);
    const maxTotal = envNumber("MAX_TOTAL", strategy.defaultMaxTotal || 50);
    const specText = strategySpecText(strategy);
    const planPath = keywordPlan?.filePath || "";
    const stageName = `daily_${today.replace(/-/g, "")}`;
    const tasks = [];
    const loginCheckTimeoutMs = envNumber("LOGIN_CHECK_TIMEOUT_MS", envNumber("BOSS_LOGIN_CHECK_TIMEOUT_MS", 90000));
    const bossCollectIdleTimeoutMs = platformIdleTimeoutMs("BOSS", "COLLECT", 300000);
    const liepinCollectIdleTimeoutMs = platformIdleTimeoutMs("LIEPIN", "COLLECT", 300000);
    const bossCollectTotalTimeoutMs = platformTimeoutMs("BOSS", "COLLECT_TOTAL", 900000);
    const liepinCollectTotalTimeoutMs = platformTimeoutMs("LIEPIN", "COLLECT_TOTAL", 900000);
    if (collectBoss) {
      tasks.push(async () => {
        const bossEnv = platformRuntimeEnv(channelConfig, "boss");
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/boss/check_boss_login_status.js"], "boss-login-check", bossEnv, { timeoutMs: loginCheckTimeoutMs });
          if (!login.ok) return { platform: "boss", ok: false, error: login.timedOut ? "登录态校验超时" : "登录态校验失败", stderr: String(login.stderr || "").slice(-4000) };
        }
        const collect = await runNodeAsync(
          ["src/platforms/boss/boss_batch_collect.js", stageName, String(perKeyword), String(maxTotal), specText, planPath],
          "boss-collect",
          bossEnv,
          { idleTimeoutMs: bossCollectIdleTimeoutMs, timeoutMs: bossCollectTotalTimeoutMs },
        );
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
    if (collectLiepin) {
      tasks.push(async () => {
        const liepinEnv = platformRuntimeEnv(channelConfig, "liepin");
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/liepin/check_liepin_login_status.js"], "liepin-login-check", liepinEnv, { timeoutMs: loginCheckTimeoutMs });
          if (!login.ok) return { platform: "liepin", ok: false, error: login.timedOut ? "登录态校验超时" : "登录态校验失败", stderr: String(login.stderr || "").slice(-4000) };
        }
        const per = envNumber("LIEPIN_PER_KEYWORD", envNumber("PER_KEYWORD", perKeyword));
        const max = envNumber("LIEPIN_MAX_TOTAL", envNumber("MAX_TOTAL", maxTotal));
        const collect = await runNodeAsync(
          ["src/platforms/liepin/liepin_batch_collect.js", stageName, String(per), String(max), specText, planPath],
          "liepin-collect",
          liepinEnv,
          { idleTimeoutMs: liepinCollectIdleTimeoutMs, timeoutMs: liepinCollectTotalTimeoutMs },
        );
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
    for (const task of tasks) results.push(await task());
    collectResults.push(...results);
    for (const result of results) {
      // v1.3 核心修正：0 条可用岗位 + 关键词错误，不能当成“部分成功”。
      // 这通常意味着 CDP/登录/风控/页面结构失败；继续跑只会生成“正常零结果”日报并占掉半天配额。
      if (result.rawPath) {
        const records = fileRecordCount(result.rawPath);
        const errors = keywordErrorCount(result.rawPath);
        if (result.ok && records === 0 && errors > 0) {
          result.ok = false;
          result.partial = false;
          result.error = `采集未获得可用岗位：${errors} 个关键词失败，已阻断空结果进入日报`;
          appendLog("collection produced no usable records", { platform: result.platform, errors, rawPath: result.rawPath });
        }
      }
      // 质量闸门：结构化字段整轮缺失（典型风控降级）降级为 partial。
      if (result.ok && result.rawPath && !result.partial) {
        const quality = assessCollectionQuality(result.platform, result.rawPath);
        if (quality && quality.degraded) {
          result.partial = true;
          result.quality = quality;
          result.error = quality.reason;
          appendLog("collection quality degraded", quality);
        }
      }
      appendLog("platform collect result", result);
      if (result.ok && result.rawPath) addPathOnce(rawPaths, result.platform, result.rawPath);
      setPlatformStatus(platformStatuses, result.platform, !result.ok ? "failed" : result.partial ? "partial_success" : "success");
      if (!result.ok || result.partial) {
        try {
          const alert = await sendWorkflowAlert(buildCollectionAlert(result), { topic: "recruitment_alert" });
          appendLog("platform collection alert attempted", { platform: result.platform, partial: Boolean(result.partial), alert });
        } catch (alertError) {
          appendLog("platform collection alert failed", { platform: result.platform, error: alertError.message });
        }
      }
    }
    if (!rawPaths.length && !ingestedPaths.length && !scoredPaths.length) throw new Error("No platform collection succeeded");
    try {
      const closedTabs = await closeCollectTabs();
      appendLog("collect tabs closed", { closed: closedTabs });
    } catch (closeError) {
      appendLog("collect tabs close skipped", { error: closeError.message });
    }
  }

  if (ingestEnabled) {
    for (const platform of ["boss", "liepin"]) {
      const enabled = platform === "boss" ? enableBoss : enableLiepin;
      if (!enabled) continue;
      const input = rawPaths.find((item) => item.platform === platform)?.path;
      if (!input) {
        appendLog("ingest skipped", { platform, reason: "no raw file" });
        continue;
      }
      const result = runNodeOptional(["src/ingest/job_ingest.js", input, `--date=${today}`], `ingest-${platform}`);
      const parsed = result.ok ? parseLastJson(result.stdout) : null;
      const item = (parsed?.results || []).find((entry) => String(entry.platform || "").toLowerCase().includes(platform)) || (parsed?.results || [])[0];
      if (!result.ok || !item?.jsonPath) {
        setPlatformStatus(platformStatuses, platform, "failed");
        appendLog("ingest failed", { platform, error: result.error?.message || "no ingested output" });
        continue;
      }
      if (!platformStatuses[platform]) setPlatformStatus(platformStatuses, platform, "success");
      addPathOnce(ingestedPaths, platform, item.jsonPath);
      const pending = Number(item.summary?.pending || 0);
      const newCount = Number(item.summary?.new_primary || 0) + Number(item.summary?.new_duplicate || 0);
      if (pending > 0) {
        setPlatformStatus(platformStatuses, platform, "partial_success");
        appendLog("ingest has pending records", { platform, pending, newCount, summary: item.summary });
      } else {
        appendLog("ingest finished", { platform, summary: item.summary });
      }
    }
  }

  if (scoreEnabled) {
    if (!ingestedPaths.length && !scoredPaths.length) throw new Error("Score stage is enabled but no ingested file is available.");
    for (const item of ingestedPaths) {
      const args = ["src/evaluate/score_jobs.js", item.path, `--date=${today}`];
      if (!envBool("ENABLE_JOB_STORE", true)) args.push("--dry-run");
      const result = runNodeOptional(args, `score-${item.platform}`);
      const parsed = result.ok ? parseLastJson(result.stdout) : null;
      if (!result.ok || !parsed?.jsonPath) {
        setPlatformStatus(platformStatuses, item.platform, "failed");
        appendLog("score failed", { platform: item.platform, error: result.error?.message || "no scored output" });
        continue;
      }
      if (!platformStatuses[item.platform]) setPlatformStatus(platformStatuses, item.platform, "success");
      addPathOnce(scoredPaths, item.platform, parsed.jsonPath);
      appendLog("score finished", { platform: item.platform, summary: parsed.summary });
    }
  }

  if (pushEnabled) {
    if (!scoredPaths.length) throw new Error("Push stage is enabled but no scored file is available. Enable ENABLE_SCORE or provide INPUT_SCORED_JSON.");
    const args = ["src/push/job_push_draft_and_send.js", ...scoredPaths.map((item) => item.path)];
    if (process.env.SEND_MODE === "send") args.push("--send");
    runNode(args, "draft-or-send");
  }

  if (envBool("ENABLE_JOB_STORE", true) && envBool("ENABLE_STATUS_REFRESH", true) && collectResults.length) {
    // v1.3：刷新“今天是否还看到”必须用本轮列表实际看到的岗位 ID，
    // 不能用“新增入库文件”——后者只含新岗位，会把所有存量岗位误判为缺失。
    for (const result of collectResults) {
      if (!result.ok || result.partial || !result.rawPath) continue;
      try {
        const payload = JSON.parse(fs.readFileSync(result.rawPath, "utf8"));
        const seenKeys = Array.isArray(payload.seen_job_ids) ? payload.seen_job_ids : [];
        if (!seenKeys.length) {
          appendLog("job-store refresh skipped", { platform: result.platform, reason: "collector did not expose seen_job_ids" });
          continue;
        }
        const refreshPath = path.join(outputsDir, `refresh_seen_${result.platform}_${Date.now()}.json`);
        writeJsonAtomic(refreshPath, {
          platform: result.platform === "boss" ? "BOSS" : "猎聘",
          dateKey: today,
          seen_job_ids: seenKeys,
          records: [...new Set(seenKeys)].map((key) => ({
            platform: result.platform === "boss" ? "BOSS" : "猎聘",
            record_key: key,
            evaluation_date: today,
          })),
        });
        runNodeOptional(
          ["src/store/job_store_update.js", "refresh", refreshPath, `--date=${today}`, `--platform=${result.platform}`],
          `job-store-refresh-${result.platform}`,
        );
      } catch (refreshError) {
        appendLog("job-store refresh skipped", { platform: result.platform, error: refreshError.message });
      }
    }
  }

  // 每日账本：机器可读 JSON/JSONL + 人可读 Markdown；同时用账本重建关键词滚动档案。
  try {
    const ledgerEntries = readLedger(today);
    const merged = mergeDay(ledgerEntries);
    const ledgerMd = writeDailySummary(today, merged);
    const ledgerJson = writeDailyJson(today, merged);
    rebuildProfilesFromLedger({ days: 30 });
    pruneLedger(90);
    appendLog("collection ledger written", { rows: merged.length, ledgerMd, ledgerJson });
  } catch (ledgerError) {
    appendLog("collection ledger skipped", { error: ledgerError.message });
  }

  const partialPlatforms = Object.entries(platformStatuses).filter(([, status]) => status === "partial_success").map(([platform]) => platform);
  const failedPlatforms = Object.entries(platformStatuses).filter(([, status]) => status === "failed").map(([platform]) => platform);
  const workflowStatus = partialPlatforms.length || failedPlatforms.length ? "partial_success" : "success";
  appendLog("workflow finished", { workflowStatus, partialPlatforms, failedPlatforms, rawPaths, ingestedPaths, scoredPaths, keywordPlan: keywordPlan?.filePath || "" });
  console.log(JSON.stringify({
    type: "workflow_result",
    status: workflowStatus,
    partialPlatforms,
    failedPlatforms,
    platformStatuses,
    rawPaths,
    ingestedPaths,
    scoredPaths,
    keywordPlan: keywordPlan?.filePath || "",
  }));
  if (partialPlatforms.length || failedPlatforms.length) process.exitCode = 2;
  releaseWorkflowLock(activeWorkflowLock);
  activeWorkflowLock = null;
}

// 直接执行（定时任务 / spawnSync）时才跑主流程；被 require 时只导出纯函数，
// 便于离线回归测试质量闸门等判定逻辑而不触发真实采集。
if (require.main === module) {
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
}

module.exports = { assessCollectionQuality, resolveCollectPlatforms, buildCollectionAlert, collectionBlockingReason };
