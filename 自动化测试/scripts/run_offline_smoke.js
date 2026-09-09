const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const scriptDir = __dirname;
const testDir = path.resolve(scriptDir, "..");
const packageRoot = path.resolve(testDir, "..");
const fixturesDir = path.join(testDir, "fixtures", "software_developer_shanghai");
const keepTemp = process.argv.includes("--keep-temp");

function shanghaiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function safeEnv(extra = {}) {
  const keep = {};
  for (const name of ["Path", "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
    if (process.env[name]) keep[name] = process.env[name];
  }
  return { ...keep, ...extra };
}

function skipPath(absPath) {
  const rel = path.relative(packageRoot, absPath).split(path.sep);
  const base = path.basename(absPath);
  if (rel.includes(".git")) return true;
  if (rel.includes("node_modules")) return true;
  if (rel.includes("vendor")) return true;
  if (rel.includes("logs")) return true;
  if (rel.includes("outputs")) return true;
  if (rel.includes("chrome-cdp-profile")) return true;
  if (base === ".env") return true;
  if (base.endsWith(".log") || base.endsWith(".jsonl")) return true;
  if (["job_store.json", "job_display_index.json", "push_state.json"].includes(base)) return true;
  return false;
}

function copyRecursive(src, dst) {
  if (skipPath(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function run(label, cwd, args, env, expectedStatus = 0) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.strictEqual(result.status, expectedStatus, `${label} exit ${result.status}, expected ${expectedStatus}`);
  return result;
}

function parseJsonOutput(stdout, label) {
  const text = String(stdout || "").trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  assert(first >= 0 && last > first, `${label} did not print JSON`);
  return JSON.parse(text.slice(first, last + 1));
}

function writeFileFromFixture(fixtureName, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, fixtureName), targetPath);
}

function removeTempSafely(tempRoot) {
  const resolved = path.resolve(tempRoot);
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error(`Refuse to remove non-temp directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-job-agent-suite-smoke-"));
  const workRoot = path.join(tempRoot, "package");
  copyRecursive(packageRoot, workRoot);

  const recruitRoot = path.join(workRoot, "AI消息群聊转发agent", "recruitment-agent");
  const messageRoot = path.join(workRoot, "定时执行agent程序", "message-platform");
  const dateKey = shanghaiDateKey();
  const missingEnvPath = path.join(tempRoot, "missing.env");
  const envPath = path.join(recruitRoot, ".env");
  const childEnvBase = safeEnv({
    RECRUITMENT_ENV_PATH: envPath,
    SUPPRESS_ALERTS: "true",
    ALERT_SEND_MODE: "none",
    FEISHU_SEND_MODE: "none",
    SEND_MODE: "draft",
    AI_DEFAULT_MODE: "rules",
    AI_SEARCH_KEYWORDS_MODE: "rules",
    AI_FIT_EVALUATION_MODE: "rules",
    AI_GREETING_MODE: "rules",
    GREETING_MODE: "rules",
  });

  try {
    console.log(`[1/6] 临时副本：${workRoot}`);

    console.log("[2/6] 验证空包 preflight 安全失败");
    const missing = run(
      "missing-env preflight",
      recruitRoot,
      ["src/main/preflight.js"],
      safeEnv({ RECRUITMENT_ENV_PATH: missingEnvPath, SUPPRESS_ALERTS: "true", ALERT_SEND_MODE: "none", FEISHU_SEND_MODE: "none" }),
      2
    );
    assert.match(`${missing.stdout}\n${missing.stderr}`, /未找到配置文件/);

    console.log("[3/6] 验证消息平台离线回归");
    run("message-platform tests", messageRoot, ["tests/run_tests.js"], safeEnv({ AI_GREETING_MODE: "rules", GREETING_MODE: "rules", FEISHU_SEND_MODE: "none" }));

    console.log("[4/6] 套用上海软件开发虚构候选人和测试配置");
    writeFileFromFixture("software_developer_shanghai.md", path.join(recruitRoot, "config", "candidate_profiles", "software_developer_shanghai.md"));
    writeFileFromFixture("current.json", path.join(recruitRoot, "config", "candidate_profiles", "current.json"));
    writeFileFromFixture("search_strategy.json", path.join(recruitRoot, "config", "search_strategy.json"));
    writeFileFromFixture("profile_rules.json", path.join(recruitRoot, "config", "profile_rules.json"));
    writeFileFromFixture("offline_smoke.env", envPath);
    fs.mkdirSync(path.join(recruitRoot, "outputs"), { recursive: true });
    const sampleInputPath = path.join(recruitRoot, "outputs", "automated_test_software_dev_stage2.json");
    writeFileFromFixture("sample_stage2_jobs.json", sampleInputPath);

    run("configured preflight", recruitRoot, ["src/main/preflight.js"], childEnvBase);

    console.log("[5/6] 验证关键词策略、评分和岗位库");
    const keywordProbe = "const {resolveSearchStrategy}=require('./src/strategy/search_keyword_generator'); resolveSearchStrategy().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack||e.message);process.exit(1);});";
    const keywordResult = run("keyword strategy", recruitRoot, ["-e", keywordProbe], childEnvBase);
    const keywordPayload = parseJsonOutput(keywordResult.stdout, "keyword strategy");
    const allKeywords = keywordPayload.strategy.levels.flatMap((level) => level.keywords);
    assert(allKeywords.includes("Java后端开发"), "software development keyword fixture was not loaded");

    const evaluateResult = run("evaluate sample jobs", recruitRoot, ["src/evaluate/evaluate_job_fit.js", sampleInputPath, dateKey, "automated_test_fit_evaluated"], childEnvBase);
    const evaluated = parseJsonOutput(evaluateResult.stdout, "evaluate sample jobs");
    assert(fs.existsSync(evaluated.outJson), "evaluated JSON not found");
    assert(evaluated.total >= 4, "expected at least four evaluated sample jobs");

    const storeResult = run("job store upsert", recruitRoot, ["src/store/job_store_update.js", "upsert", evaluated.outJson, `--date=${dateKey}`], childEnvBase);
    const storePayload = parseJsonOutput(storeResult.stdout, "job store upsert");
    assert(fs.existsSync(path.join(recruitRoot, "data", "job_store.json")), "job_store.json not generated in temp copy");
    assert(storePayload.trackedFiles && storePayload.trackedFiles[0] && fs.existsSync(storePayload.trackedFiles[0].jsonPath), "tracked output not generated");

    console.log("[6/6] 验证日报草稿和规则话术");
    const draftResult = run("draft generation", recruitRoot, ["src/push/job_push_draft_and_send.js", storePayload.trackedFiles[0].jsonPath], childEnvBase);
    const draftPayload = parseJsonOutput(draftResult.stdout, "draft generation");
    assert.strictEqual(draftPayload.sendMode, "draft");
    assert(draftPayload.priorityCount >= 1, "expected at least one recommendable draft item");
    assert(draftPayload.messages.every((message) => message.feishu && message.feishu.skipped), "draft mode must not send Feishu");
    assert(draftPayload.messages.some((message) => fs.existsSync(message.txtPath)), "draft txt was not generated");
    const draftText = draftPayload.messages.flatMap((message) => message.items || []).map((item) => item.message_text || "").join("\n");
    assert.match(draftText, /Java|Spring|后端|软件开发|微服务/, "rule greeting should reflect the software-development fixture");
    assert.doesNotMatch(draftText, /千万级AI项目/, "rule greeting must not reuse the old hard-coded AI project template");

    const aiLogPath = path.join(recruitRoot, "logs", "ai_calls.log");
    const aiLog = fs.existsSync(aiLogPath) ? fs.readFileSync(aiLogPath, "utf8") : "";
    assert(!/codex_runtime|openai_api/.test(aiLog), "offline smoke test should not call Codex runtime or OpenAI API");

    console.log(JSON.stringify({
      type: "offline_smoke_result",
      ok: true,
      tempRoot: keepTemp ? workRoot : "(removed)",
      candidate: "software_developer_shanghai_demo",
      dateKey,
      evaluatedTotal: evaluated.total,
      draftPriorityCount: draftPayload.priorityCount,
      aiMode: "rules",
      sent: false,
    }, null, 2));
  } finally {
    if (!keepTemp) removeTempSafely(tempRoot);
    else console.log(`保留临时目录：${tempRoot}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
