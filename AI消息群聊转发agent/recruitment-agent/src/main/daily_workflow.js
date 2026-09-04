const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadEnv, envBool, envNumber } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { sendRecruitmentNotification } = require("../push/outbound_sender");
const { resolveSearchStrategy } = require("../strategy/search_keyword_generator");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(rootDir, "outputs");
const logDir = path.join(rootDir, "logs");
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

function runNodeAsync(args, label, env = process.env) {
  appendLog(`${label} started`, { args });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: rootDir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (status) => {
      if (status === 0) appendLog(`${label} finished`);
      else appendLog(`${label} failed`, { status, stderr: stderr.slice(-2000) });
      resolve({ ok: status === 0, status, stdout, stderr });
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

function platformEnabled(name, defaultValue) {
  return envBool(`ENABLE_${name.toUpperCase()}`, defaultValue);
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
  ensureDir(outputsDir);
  appendLog("workflow started", { today });
  const enableBoss = platformEnabled("boss", true);
  const enableLiepin = platformEnabled("liepin", false);
  const rawPaths = [];
  const screenedPaths = [];
  const evaluatedPaths = [];
  const partialPlatforms = [];
  const failedPlatforms = [];
  if (process.env.INPUT_RAW_JSON) rawPaths.push({ platform: "boss", path: assertFreshInput(process.env.INPUT_RAW_JSON, today, "BOSS raw") });
  if (process.env.INPUT_LIEPIN_RAW_JSON) rawPaths.push({ platform: "liepin", path: assertFreshInput(process.env.INPUT_LIEPIN_RAW_JSON, today, "猎聘 raw") });
  if (process.env.INPUT_SCREENED_JSON) screenedPaths.push({ platform: "boss", path: assertFreshInput(process.env.INPUT_SCREENED_JSON, today, "BOSS screened") });
  if (process.env.INPUT_LIEPIN_SCREENED_JSON) screenedPaths.push({ platform: "liepin", path: assertFreshInput(process.env.INPUT_LIEPIN_SCREENED_JSON, today, "猎聘 screened") });
  if (process.env.INPUT_EVALUATED_JSON) evaluatedPaths.push({ platform: "boss", path: assertFreshInput(process.env.INPUT_EVALUATED_JSON, today, "BOSS evaluated") });
  if (process.env.INPUT_LIEPIN_EVALUATED_JSON) evaluatedPaths.push({ platform: "liepin", path: assertFreshInput(process.env.INPUT_LIEPIN_EVALUATED_JSON, today, "猎聘 evaluated") });

  if (envBool("ENABLE_COLLECT", true)) {
    const strategy = await keywordSpecText();
    appendLog("search keyword strategy resolved", strategy.ai);
    const stageName = `daily_${today.replace(/-/g, "")}`;
    const tasks = [];
    if (enableBoss) {
      tasks.push((async () => {
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/boss/check_boss_login_status.js"], "boss-login-check");
          if (!login.ok) return { platform: "boss", ok: false, error: "登录态校验失败", stderr: String(login.stderr || "").slice(-4000) };
        }
        const collect = await runNodeAsync(["src/platforms/boss/boss_batch_collect.js", stageName, String(strategy.perKeyword), String(strategy.maxTotal), strategy.specText], "boss-collect");
        if (!collect.ok) {
          const partialPath = tryLatestFile(new RegExp(`^boss_${stageName}_jobs_.*\\.json$`));
          if (partialPath) return { platform: "boss", ok: true, partial: true, rawPath: partialPath, error: "采集部分完成，部分关键词失败", stderr: String(collect.stderr || "").slice(-4000) };
          return { platform: "boss", ok: false, error: "采集进程失败", stderr: String(collect.stderr || "").slice(-4000) };
        }
        return { platform: "boss", ok: true, rawPath: latestFile(new RegExp(`^boss_${stageName}_jobs_.*\\.json$`)) };
      })());
    }
    if (enableLiepin) {
      tasks.push((async () => {
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/liepin/check_liepin_login_status.js"], "liepin-login-check");
          if (!login.ok) return { platform: "liepin", ok: false, error: "登录态校验失败", stderr: String(login.stderr || "").slice(-4000) };
        }
        const per = envNumber("LIEPIN_PER_KEYWORD", envNumber("PER_KEYWORD", strategy.perKeyword));
        const max = envNumber("LIEPIN_MAX_TOTAL", envNumber("MAX_TOTAL", strategy.maxTotal));
        const collect = await runNodeAsync(["src/platforms/liepin/liepin_batch_collect.js", stageName, String(per), String(max), strategy.specText], "liepin-collect");
        if (!collect.ok) {
          const partialPath = tryLatestFile(new RegExp(`^liepin_${stageName}_jobs_.*\\.json$`));
          if (partialPath) return { platform: "liepin", ok: true, partial: true, rawPath: partialPath, error: "采集部分完成，部分关键词失败", stderr: String(collect.stderr || "").slice(-4000) };
          return { platform: "liepin", ok: false, error: "采集进程失败", stderr: String(collect.stderr || "").slice(-4000) };
        }
        return { platform: "liepin", ok: true, rawPath: latestFile(new RegExp(`^liepin_${stageName}_jobs_.*\\.json$`)) };
      })());
    }
    const results = await Promise.all(tasks);
    for (const result of results) {
      appendLog("platform collect result", result);
      if (result.ok && result.rawPath) rawPaths.push({ platform: result.platform, path: result.rawPath });
      if (!result.ok || result.partial) {
        if (!result.ok) failedPlatforms.push(result.platform);
        if (result.partial) partialPlatforms.push(result.platform);
        const level = result.partial ? "部分成功" : "失败";
        try {
          const alert = await sendRecruitmentNotification(buildCollectionAlert(result), { topic: "recruitment_alert" });
          appendLog("platform collection alert attempted", { platform: result.platform, partial: Boolean(result.partial), alert });
        } catch (alertError) {
          appendLog("platform collection alert failed", { platform: result.platform, error: alertError.message });
        }
      }
    }
    if (!rawPaths.length) throw new Error("No platform collection succeeded");
  }
  if (envBool("ENABLE_SCREEN", true)) {
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
  if (envBool("ENABLE_EVALUATE", true)) {
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
  if (envBool("ENABLE_PUSH", true)) {
    if (!evaluatedPaths.length) throw new Error("No evaluated files available for push");
    const args = ["src/push/job_push_draft_and_send.js", ...evaluatedPaths.map((item) => item.path)];
    if (process.env.SEND_MODE === "send") args.push("--send");
    runNode(args, "draft-or-send");
  }
  if (envBool("ENABLE_JOB_STORE", true) && envBool("ENABLE_STATUS_REFRESH", true) && evaluatedPaths.length) {
    const args = ["src/store/job_store_update.js", "refresh", ...evaluatedPaths.map((item) => item.path), `--date=${today}`];
    runNodeOptional(args, "job-store-refresh");
  }
  const workflowStatus = partialPlatforms.length || failedPlatforms.length ? "partial_success" : "success";
  appendLog("workflow finished", { workflowStatus, partialPlatforms, failedPlatforms, rawPaths, screenedPaths, evaluatedPaths });
  console.log(JSON.stringify({ type: "workflow_result", status: workflowStatus, partialPlatforms, failedPlatforms, rawPaths, screenedPaths, evaluatedPaths }));
  if (partialPlatforms.length || failedPlatforms.length) process.exitCode = 2;
}

main().catch(async (error) => {
  appendLog("workflow failed", { error: error.stack || error.message });
  try {
    const alert = await sendRecruitmentNotification(`【招聘信息智能体告警】${today} 流程运行失败：${error.message}`, { topic: "recruitment_alert" });
    appendLog("failure alert attempted", { delivered: Boolean(alert?.status >= 200 && alert?.status < 300), result: alert });
  } catch (alertError) {
    appendLog("failure alert failed", { error: alertError.message });
  }
  process.exitCode = 1;
});
