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

function runPowerShell(label, cwd, args, env, expectedStatus = 0) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
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

  const recruitRoot = path.join(workRoot, "招聘智能体", "recruitment-agent");
  const messageRoot = path.join(workRoot, "消息平台", "message-platform");
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
    console.log(`[1/7] 临时副本：${workRoot}`);

    console.log("[2/7] 验证空包 preflight 安全失败");
    const missing = run(
      "missing-env preflight",
      recruitRoot,
      ["src/main/preflight.js"],
      safeEnv({ RECRUITMENT_ENV_PATH: missingEnvPath, SUPPRESS_ALERTS: "true", ALERT_SEND_MODE: "none", FEISHU_SEND_MODE: "none" }),
      2
    );
    assert.match(`${missing.stdout}\n${missing.stderr}`, /未找到配置文件/);

    console.log("[3/7] 验证消息平台离线回归");
    run("message-platform tests", messageRoot, ["tests/run_tests.js"], safeEnv({ AI_GREETING_MODE: "rules", GREETING_MODE: "rules", FEISHU_SEND_MODE: "none" }));

    console.log("[4/7] 套用上海软件开发虚构候选人和测试配置");
    writeFileFromFixture("software_developer_shanghai.md", path.join(recruitRoot, "config", "candidate_profiles", "software_developer_shanghai.md"));
    writeFileFromFixture("current.json", path.join(recruitRoot, "config", "candidate_profiles", "current.json"));
    writeFileFromFixture("search_strategy.json", path.join(recruitRoot, "config", "search_strategy.json"));
    writeFileFromFixture("profile_rules.json", path.join(recruitRoot, "config", "profile_rules.json"));
    writeFileFromFixture("offline_smoke.env", envPath);
    const channelConfigPath = path.join(recruitRoot, "config", "platform_channels.json");
    const channelConfig = JSON.parse(fs.readFileSync(channelConfigPath, "utf8"));
    assert.strictEqual(channelConfig.platforms.boss.enabled, false, "share package BOSS flow must start disabled");
    assert.strictEqual(channelConfig.platforms.liepin.enabled, false, "share package Liepin flow must start disabled");
    assert.strictEqual(channelConfig.platforms.boss.detail_capture, true, "BOSS detail capture should be the default when the platform is enabled");
    channelConfig.platforms.boss.enabled = true;
    fs.writeFileSync(channelConfigPath, `${JSON.stringify(channelConfig, null, 2)}\n`, "utf8");
    fs.mkdirSync(path.join(recruitRoot, "outputs"), { recursive: true });
    const sampleInputPath = path.join(recruitRoot, "outputs", "automated_test_software_dev_stage2.json");
    writeFileFromFixture("sample_stage2_jobs.json", sampleInputPath);

    run("configured preflight", recruitRoot, ["src/main/preflight.js"], childEnvBase);

    console.log("[5/7] 验证配置保护、定时发送默认值和关键词策略");
    const disabledEnvPath = path.join(recruitRoot, "all_disabled.env");
    fs.writeFileSync(disabledEnvPath, [
      "ENABLE_COLLECT=false",
      "ENABLE_SCREEN=false",
      "ENABLE_EVALUATE=false",
      "ENABLE_PUSH=false",
      "SEND_MODE=draft",
      "FEISHU_SEND_MODE=none",
      "SUPPRESS_ALERTS=true",
    ].join("\n"), "utf8");
    const disabledPreflight = run(
      "all-disabled preflight",
      recruitRoot,
      ["src/main/preflight.js"],
      safeEnv({ RECRUITMENT_ENV_PATH: disabledEnvPath, SUPPRESS_ALERTS: "true", ALERT_SEND_MODE: "none", FEISHU_SEND_MODE: "none" }),
      2
    );
    assert.match(`${disabledPreflight.stdout}\n${disabledPreflight.stderr}`, /采集、筛选、评价和报告均处于关闭状态/);
    const disabledWorkflow = run(
      "all-disabled workflow",
      recruitRoot,
      ["src/main/daily_workflow.js"],
      safeEnv({
        RECRUITMENT_ENV_PATH: disabledEnvPath,
        ENABLE_COLLECT: "false",
        ENABLE_SCREEN: "false",
        ENABLE_EVALUATE: "false",
        ENABLE_PUSH: "false",
        SUPPRESS_ALERTS: "true",
        ALERT_SEND_MODE: "none",
        FEISHU_SEND_MODE: "none",
      }),
      1
    );
    assert.match(`${disabledWorkflow.stdout}\n${disabledWorkflow.stderr}`, /No workflow stages are enabled/);

    const missingInputWorkflow = run(
      "missing-input workflow",
      recruitRoot,
      ["src/main/daily_workflow.js"],
      safeEnv({
        RECRUITMENT_ENV_PATH: disabledEnvPath,
        ENABLE_COLLECT: "false",
        ENABLE_SCREEN: "true",
        ENABLE_EVALUATE: "true",
        ENABLE_PUSH: "true",
        ENABLE_BOSS: "true",
        ENABLE_LIEPIN: "false",
        SUPPRESS_ALERTS: "true",
        ALERT_SEND_MODE: "none",
        FEISHU_SEND_MODE: "none",
        SEND_MODE: "draft",
      }),
      1
    );
    assert.match(`${missingInputWorkflow.stdout}\n${missingInputWorkflow.stderr}`, /No fresh input is available/);

    const scheduleProbe = [
      "delete process.env.SCHEDULE_SEND_MODE;",
      "const { scheduledSendMode } = require('./src/main/scheduled_entry');",
      "console.log(JSON.stringify({ mode: scheduledSendMode() }));",
    ].join(" ");
    const scheduleResult = run("scheduled send safe default", recruitRoot, ["-e", scheduleProbe], childEnvBase);
    assert.strictEqual(parseJsonOutput(scheduleResult.stdout, "scheduled send safe default").mode, "draft");
    const taskPlanResult = runPowerShell("independent scheduled task plan", recruitRoot, ["-File", "bin/create_windows_task.example.ps1", "-GenerateOnly"], childEnvBase);
    const taskPlan = parseJsonOutput(taskPlanResult.stdout, "independent scheduled task plan");
    assert.strictEqual(taskPlan.triggerCount, 14, "expected ten hourly collection triggers and four report triggers");
    assert.strictEqual(taskPlan.independentTriggers, true, "task plan must not use a repetition chain");
    assert.strictEqual(taskPlan.wakeComputer, false, "task plan must not wake the computer");
    assert.strictEqual(taskPlan.startWhenAvailable, false, "missed times must not catch up");
    assert.strictEqual(taskPlan.scheduledArgument, true, "main Windows task must call the decision entry with -Scheduled");
    assert.strictEqual(taskPlan.watchdogTime, "21:05");
    assert.deepStrictEqual(taskPlan.legacyTaskNames, ["BOSS Job Agent Daily"], "registration must clean the obsolete task after replacement verification");

    const schedulePolicyProbe = [
      "const {loadSchedulePolicy}=require('./src/core/schedule_policy');",
      "const {decide}=require('./src/main/scheduled_entry');",
      "const p=loadSchedulePolicy().policy;",
      "const partial={collectRuns:[{at:'2026-09-10T01:05:00.000Z',dateKey:'2026-09-10',slot:'morning',status:'partial_success'}],reportRuns:[]};",
      "const morningSuccess={collectRuns:[{at:'2026-09-10T01:00:00.000Z',dateKey:'2026-09-10',slot:'morning',status:'success'}],reportRuns:[]};",
      "const lateMorningSuccess={collectRuns:[{at:'2026-09-10T04:00:00.000Z',dateKey:'2026-09-10',slot:'morning',status:'success'}],reportRuns:[]};",
      "const freshAfternoonSuccess={collectRuns:[{at:'2026-09-10T10:00:00.000Z',dateKey:'2026-09-10',slot:'afternoon',status:'success'}],reportRuns:[]};",
      "const oldAfternoonSuccess={collectRuns:[{at:'2026-09-10T08:00:00.000Z',dateKey:'2026-09-10',slot:'afternoon',status:'success'}],reportRuns:[]};",
      "const failedReport={collectRuns:freshAfternoonSuccess.collectRuns,reportRuns:[{at:'2026-09-10T11:00:00.000Z',dateKey:'2026-09-10',slot:'delivery',status:'failed'}]};",
      "const successfulReport={collectRuns:freshAfternoonSuccess.collectRuns,reportRuns:[{at:'2026-09-10T11:00:00.000Z',dateKey:'2026-09-10',slot:'delivery',status:'success'}]};",
      "console.log(JSON.stringify({policy:p,afterPartial:decide(partial,new Date('2026-09-10T10:00:00+08:00'),p),beforeWindow:decide({collectRuns:[],reportRuns:[]},new Date('2026-09-10T08:59:00+08:00'),p),morningDue:decide({collectRuns:[],reportRuns:[]},new Date('2026-09-10T09:00:00+08:00'),p),morningQuota:decide(morningSuccess,new Date('2026-09-10T10:00:00+08:00'),p),afternoonGapBlocked:decide(lateMorningSuccess,new Date('2026-09-10T13:00:00+08:00'),p),afternoonDue:decide(lateMorningSuccess,new Date('2026-09-10T14:00:00+08:00'),p),freshReport:decide(freshAfternoonSuccess,new Date('2026-09-10T19:00:00+08:00'),p),staleReport:decide(oldAfternoonSuccess,new Date('2026-09-10T19:00:00+08:00'),p),noCollectionReport:decide({collectRuns:[],reportRuns:[]},new Date('2026-09-10T19:00:00+08:00'),p),earlyRetry:decide(failedReport,new Date('2026-09-10T19:15:00+08:00'),p),dueRetry:decide(failedReport,new Date('2026-09-10T19:30:00+08:00'),p),alreadyDelivered:decide(successfulReport,new Date('2026-09-10T19:30:00+08:00'),p),afterWindow:decide({collectRuns:[],reportRuns:[]},new Date('2026-09-10T21:00:00+08:00'),p)}));",
    ].join(" ");
    const schedulePolicyResult = run("schedule policy", recruitRoot, ["-e", schedulePolicyProbe], childEnvBase);
    const schedulePolicyPayload = parseJsonOutput(schedulePolicyResult.stdout, "schedule policy");
    assert.deepStrictEqual(schedulePolicyPayload.policy.collection_windows.map((item) => [item.id, item.start, item.end]), [["morning", "09:00", "13:00"], ["afternoon", "13:00", "19:00"]]);
    assert.strictEqual(schedulePolicyPayload.afterPartial.action, "collect_only", "partial collection must not consume the half-day success quota");
    assert.strictEqual(schedulePolicyPayload.beforeWindow.shouldRun, false);
    assert.strictEqual(schedulePolicyPayload.morningDue.action, "collect_only");
    assert.strictEqual(schedulePolicyPayload.morningQuota.shouldRun, false, "a successful morning run must consume the morning quota");
    assert.strictEqual(schedulePolicyPayload.afternoonGapBlocked.shouldRun, false, "afternoon collection must wait for the configured two-hour gap");
    assert.strictEqual(schedulePolicyPayload.afternoonDue.action, "collect_only");
    assert.strictEqual(schedulePolicyPayload.freshReport.action, "report_only", "fresh collection should be reused by the report");
    assert.strictEqual(schedulePolicyPayload.staleReport.action, "collect_and_report", "a collection at least two hours old should be refreshed before reporting");
    assert.strictEqual(schedulePolicyPayload.noCollectionReport.action, "collect_and_report");
    assert.strictEqual(schedulePolicyPayload.earlyRetry.shouldRun, false, "report retry must wait thirty minutes");
    assert.strictEqual(schedulePolicyPayload.dueRetry.action, "report_only");
    assert.strictEqual(schedulePolicyPayload.alreadyDelivered.shouldRun, false);
    assert.strictEqual(schedulePolicyPayload.afterWindow.shouldRun, false);

    const bossDetailSource = fs.readFileSync(path.join(recruitRoot, "src", "platforms", "boss", "boss_batch_collect.js"), "utf8");
    assert.match(bossDetailSource, /await searchUi\(ws, keyword, job\.jobName\)/, "every BOSS detail card must restore its keyword search");
    assert.match(bossDetailSource, /Page\.navigate/, "BOSS detail links should stay in the controlled CDP tab");
    const bossFallbackProbe = [
      "const {extractRecord}=require('./src/platforms/boss/boss_batch_collect');",
      "const r=extractRecord({keyword:'AI产品经理',searchStrategyType:'岗位信息',listJob:{jobName:'AI产品经理',brandName:'测试公司',salaryDesc:'20-30K',cityName:'上海',skills:['AI']},captures:[],page:{text:'AI产品经理 这是整页中另一个岗位的描述'}});",
      "console.log(JSON.stringify({status:r.collection_status,jd:r.job_description,notes:r.notes}));",
    ].join(" ");
    const bossFallbackResult = run("BOSS safe detail fallback", recruitRoot, ["-e", bossFallbackProbe], childEnvBase);
    const bossFallback = parseJsonOutput(bossFallbackResult.stdout, "BOSS safe detail fallback");
    assert.strictEqual(bossFallback.status, "detail_not_captured");
    assert.strictEqual(bossFallback.jd, "", "a whole list page must never be stored as one job's description");
    assert.match(bossFallback.notes, /避免岗位串档/);

    const keywordProbe = "const {resolveSearchStrategy}=require('./src/strategy/search_keyword_generator'); resolveSearchStrategy().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack||e.message);process.exit(1);});";
    const keywordResult = run("keyword strategy", recruitRoot, ["-e", keywordProbe], childEnvBase);
    const keywordPayload = parseJsonOutput(keywordResult.stdout, "keyword strategy");
    const allKeywords = keywordPayload.strategy.levels.flatMap((level) => level.keywords);
    assert(allKeywords.includes("Java后端开发"), "software development keyword fixture was not loaded");

    console.log("[6/7] 验证评分、空字段语义和岗位库");
    const evaluateResult = run("evaluate sample jobs", recruitRoot, ["src/evaluate/evaluate_job_fit.js", sampleInputPath, dateKey, "automated_test_fit_evaluated"], childEnvBase);
    const evaluated = parseJsonOutput(evaluateResult.stdout, "evaluate sample jobs");
    assert(fs.existsSync(evaluated.outJson), "evaluated JSON not found");
    assert(evaluated.total >= 4, "expected at least four evaluated sample jobs");

    const missingMetadataInputPath = path.join(recruitRoot, "outputs", "automated_test_missing_metadata_stage2.json");
    fs.writeFileSync(missingMetadataInputPath, JSON.stringify({ records: [{
      platform: "BOSS直聘",
      record_key: "boss:test-missing-metadata",
      company: "虚构智能科技公司",
      job_title: "AI智能体项目经理",
      salary: "",
      salary_min_k: "",
      salary_max_k: "",
      city: "上海",
      district: "徐汇区",
      job_description: "负责 AI 智能体平台、企业服务、需求分析、项目交付、私有化部署、UAT 验收与跨部门协同。",
      boss_active_text: "",
      active_days: "",
      collection_status: "list_api_only",
      keyword: "AI智能体项目经理"
    }] }, null, 2), "utf8");
    const missingMetadataResult = run("evaluate missing metadata", recruitRoot, ["src/evaluate/evaluate_job_fit.js", missingMetadataInputPath, dateKey, "automated_test_missing_metadata_evaluated"], childEnvBase);
    const missingMetadataOutput = parseJsonOutput(missingMetadataResult.stdout, "evaluate missing metadata");
    const missingMetadataRows = JSON.parse(fs.readFileSync(missingMetadataOutput.outJson, "utf8")).records;
    assert.strictEqual(missingMetadataRows[0].salary_fit_score, 55, "blank job salary must be unknown, not zero salary");
    assert.strictEqual(missingMetadataRows[0].activity_fit_score, 58, "blank recruiter activity must be unknown, not active today");
    assert.strictEqual(missingMetadataRows[0].detail_confidence_score, 55, "list-only BOSS job should remain a preliminary candidate");
    assert(["重点关注-需确认详情", "可关注"].includes(missingMetadataRows[0].focus_level), "strong list-only job should be recommendable with a manual-confirmation label");

    const storeResult = run("job store upsert", recruitRoot, ["src/store/job_store_update.js", "upsert", evaluated.outJson, `--date=${dateKey}`], childEnvBase);
    const storePayload = parseJsonOutput(storeResult.stdout, "job store upsert");
    assert(fs.existsSync(path.join(recruitRoot, "data", "job_store.json")), "job_store.json not generated in temp copy");
    assert(storePayload.trackedFiles && storePayload.trackedFiles[0] && fs.existsSync(storePayload.trackedFiles[0].jsonPath), "tracked output not generated");

    const isolationProbe = [
      "const {refreshMissingOpenJobs}=require('./src/store/job_store');",
      "const s={jobs:{'boss:old':{platform:'BOSS',job_status:'open',first_seen_date:'2026-09-01',last_seen_date:'2026-09-01'},'liepin:old':{platform:'猎聘',job_status:'open',first_seen_date:'2026-09-01',last_seen_date:'2026-09-01'}},runs:[]};",
      `const r=refreshMissingOpenJobs(s,[],{dateKey:'${dateKey}',platforms:['boss'],closeAfterDays:7});`,
      "console.log(JSON.stringify({boss:s.jobs['boss:old'].job_status,liepin:s.jobs['liepin:old'].job_status,platforms:r.platforms}));",
    ].join(" ");
    const isolationResult = run("platform refresh isolation", recruitRoot, ["-e", isolationProbe], childEnvBase);
    const isolation = parseJsonOutput(isolationResult.stdout, "platform refresh isolation");
    assert.strictEqual(isolation.boss, "unknown");
    assert.strictEqual(isolation.liepin, "open", "BOSS refresh must not change Liepin history");

    console.log("[7/7] 验证日报草稿、零结果说明和规则话术");
    const draftResult = run("draft generation", recruitRoot, ["src/push/job_push_draft_and_send.js", storePayload.trackedFiles[0].jsonPath], childEnvBase);
    const draftPayload = parseJsonOutput(draftResult.stdout, "draft generation");
    assert.strictEqual(draftPayload.sendMode, "draft");
    assert(draftPayload.priorityCount >= 1, "expected at least one recommendable draft item");
    assert(draftPayload.messages.every((message) => message.feishu && message.feishu.skipped), "draft mode must not send Feishu");
    assert(draftPayload.messages.some((message) => fs.existsSync(message.txtPath)), "draft txt was not generated");
    const draftText = draftPayload.messages.flatMap((message) => message.items || []).map((item) => item.message_text || "").join("\n");
    assert.match(draftText, /Java|Spring|后端|软件开发|微服务/, "rule greeting should reflect the software-development fixture");
    assert.doesNotMatch(draftText, /千万级AI项目/, "rule greeting must not reuse the old hard-coded AI project template");

    const emptyEvaluatedPath = path.join(recruitRoot, "outputs", "automated_test_empty_evaluated.json");
    fs.writeFileSync(emptyEvaluatedPath, JSON.stringify({ records: [] }, null, 2), "utf8");
    const emptyDraftResult = run("empty-result draft generation", recruitRoot, ["src/push/job_push_draft_and_send.js", emptyEvaluatedPath], { ...childEnvBase, PUSH_STATE_PATH: path.join(recruitRoot, "data", "empty_push_state.json") });
    const emptyDraftPayload = parseJsonOutput(emptyDraftResult.stdout, "empty-result draft generation");
    const emptyDraftText = emptyDraftPayload.messages.map((message) => fs.readFileSync(message.txtPath, "utf8")).join("\n");
    assert.match(emptyDraftText, /没有返回岗位|没有岗位达到|没有新增或内容发生变化/, "zero-result report must explain why it contains no recommendations");

    const watchdogResult = run("watchdog dry alert", recruitRoot, ["src/main/report_watchdog.js"], {
      ...childEnvBase,
      WATCHDOG_DATE: "2099-01-01",
      WATCHDOG_SEND_MODE: "draft",
      SCHEDULE_SEND_MODE: "send",
      SKIP_TASK_HEALTH_CHECK: "true",
    });
    const watchdog = parseJsonOutput(watchdogResult.stdout, "watchdog dry alert");
    assert.strictEqual(watchdog.ok, false);
    assert.strictEqual(watchdog.delivered, false, "dry watchdog test must not send a real notification");

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
