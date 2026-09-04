const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadEnv, envBool, envNumber } = require("../core/load_env");
const { validatePreflight, errorText, configuredEnvPath } = require("../core/preflight");
const { shanghaiDateKey } = require("../core/time_utils");
const { sendRecruitmentNotification } = require("../push/outbound_sender");
const { resolveSearchStrategy } = require("../strategy/search_keyword_generator");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(rootDir, "outputs");
const logDir = path.join(rootDir, "logs");
const strategyPath = path.join(rootDir, "config", "search_strategy.json");
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
  return { ai: resolved.ai,
    perKeyword: envNumber("PER_KEYWORD", config.defaultPerKeyword || 8),
    maxTotal: envNumber("MAX_TOTAL", config.defaultMaxTotal || 50),
    specText: specs.join(",")
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

async function main() {
  loadEnv(configuredEnvPath());
  const preflight = validatePreflight();
  if (!preflight.ok) {
    appendLog("preflight failed", { issues: preflight.issues, envPath: preflight.envPath });
    console.error(JSON.stringify({ type: "preflight_failed", message: "启动前配置检查未通过", issues: preflight.issues }));
    process.exitCode = 2;
    return;
  }
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
          if (!login.ok) return { platform: "boss", ok: false, error: "login-check failed" };
        }
        const collect = await runNodeAsync(["src/platforms/boss/boss_batch_collect.js", stageName, String(strategy.perKeyword), String(strategy.maxTotal), strategy.specText], "boss-collect");
        if (!collect.ok) {
          const partialPath = tryLatestFile(new RegExp(`^boss_${stageName}_jobs_.*\\.json$`));
          if (partialPath) return { platform: "boss", ok: true, partial: true, rawPath: partialPath, error: "collect ended with partial data" };
          return { platform: "boss", ok: false, error: "collect failed" };
        }
        return { platform: "boss", ok: true, rawPath: latestFile(new RegExp(`^boss_${stageName}_jobs_.*\\.json$`)) };
      })());
    }
    if (enableLiepin) {
      tasks.push((async () => {
        if (envBool("ENABLE_LOGIN_CHECK", true)) {
          const login = await runNodeAsync(["src/platforms/liepin/check_liepin_login_status.js"], "liepin-login-check");
          if (!login.ok) return { platform: "liepin", ok: false, error: "login-check failed" };
        }
        const per = envNumber("LIEPIN_PER_KEYWORD", envNumber("PER_KEYWORD", strategy.perKeyword));
        const max = envNumber("LIEPIN_MAX_TOTAL", envNumber("MAX_TOTAL", strategy.maxTotal));
        const collect = await runNodeAsync(["src/platforms/liepin/liepin_batch_collect.js", stageName, String(per), String(max), strategy.specText], "liepin-collect");
        if (!collect.ok) {
          const partialPath = tryLatestFile(new RegExp(`^liepin_${stageName}_jobs_.*\\.json$`));
          if (partialPath) return { platform: "liepin", ok: true, partial: true, rawPath: partialPath, error: "collect ended with partial data" };
          return { platform: "liepin", ok: false, error: "collect failed" };
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
          const alert = await sendRecruitmentNotification(`【招聘信息智能体告警】${today} ${result.platform}采集${level}：${result.error || "请查看本地日志"}`, { topic: "recruitment_alert" });
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
