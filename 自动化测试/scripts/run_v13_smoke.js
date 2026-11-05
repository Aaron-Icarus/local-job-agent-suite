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
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
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
  if (rel.includes(".git") || rel.includes("node_modules")) return true;
  if (rel.includes("logs") || rel.includes("outputs")) return true;
  if (rel.includes("data")) return base !== ".gitkeep" && !rel.includes("candidate_profiles") && !rel.includes("config");
  return false;
}

function copyRecursive(src, dst) {
  if (skipPath(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dst, entry));
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function run(label, cwd, args, env, expectedStatus = 0) {
  const result = spawnSync(process.execPath, args, {
    cwd, env, encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.strictEqual(result.status, expectedStatus, `${label} exit ${result.status}, expected ${expectedStatus}\n${result.stderr || ""}`);
  return result;
}

function parseJsonOutput(stdout, label) {
  const text = String(stdout || "").trim();
  const arrayStart = text.indexOf("[");
  const objectStart = text.indexOf("{");
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    const arrayEnd = text.lastIndexOf("]");
    assert(arrayEnd > arrayStart, `${label} did not print JSON array`);
    return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
  }
  const first = objectStart;
  const last = text.lastIndexOf("}");
  assert(first >= 0 && last > first, `${label} did not print JSON`);
  return JSON.parse(text.slice(first, last + 1));
}

function writeFixture(name, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, name), targetPath);
}

function removeTempSafely(tempRoot) {
  const resolved = path.resolve(tempRoot);
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) throw new Error(`Refuse to remove non-temp directory: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-job-agent-v13-smoke-"));
  const workRoot = path.join(tempRoot, "package");
  copyRecursive(packageRoot, workRoot);
  const recruitRoot = path.join(workRoot, "招聘智能体", "recruitment-agent");
  const messageRoot = path.join(workRoot, "消息平台", "message-platform");
  const dateKey = shanghaiDateKey();
  const envPath = path.join(recruitRoot, ".env");
  const storePath = path.join(recruitRoot, "data", "smoke_job_store.json");
  const childEnv = safeEnv({
    RECRUITMENT_ENV_PATH: envPath,
    JOB_STORE_PATH: storePath,
    SUPPRESS_ALERTS: "true",
    ALERT_SEND_MODE: "none",
    FEISHU_SEND_MODE: "none",
    SEND_MODE: "draft",
    AI_DEFAULT_MODE: "disabled",
    AI_SCORE_REVIEW_ENABLED: "false",
    PLATFORM_ENV_OVERRIDE: "true",
    ENABLE_BOSS: "true",
    ENABLE_LIEPIN: "false",
  });

  try {
    console.log(`[1/8] 临时副本：${workRoot}`);

    console.log("[2/8] 空包 preflight 安全失败");
    const missingEnv = path.join(tempRoot, "missing.env");
    run("missing-env preflight", recruitRoot, ["src/main/preflight.js"], safeEnv({ RECRUITMENT_ENV_PATH: missingEnv, SUPPRESS_ALERTS: "true", ALERT_SEND_MODE: "none" }), 2);

    console.log("[3/8] 消息平台离线回归");
    run("message-platform tests", messageRoot, ["tests/run_tests.js"], safeEnv({ AI_GREETING_MODE: "rules", GREETING_MODE: "rules", FEISHU_SEND_MODE: "none" }));

    console.log("[4/8] 套用上海软件开发虚构候选人");
    writeFixture("software_developer_shanghai.md", path.join(recruitRoot, "config", "candidate_profiles", "software_developer_shanghai.md"));
    writeFixture("current.json", path.join(recruitRoot, "config", "candidate_profiles", "current.json"));
    writeFixture("search_strategy.json", path.join(recruitRoot, "config", "search_strategy.json"));
    writeFixture("profile_rules.json", path.join(recruitRoot, "config", "profile_rules.json"));
    writeFixture("offline_smoke.env", envPath);
    const channelPath = path.join(recruitRoot, "config", "platform_channels.json");
    const channels = JSON.parse(fs.readFileSync(channelPath, "utf8"));
    channels.platforms.boss.enabled = true;
    channels.platforms.liepin.enabled = false;
    fs.writeFileSync(channelPath, `${JSON.stringify(channels, null, 2)}\n`, "utf8");
    run("configured preflight", recruitRoot, ["src/main/preflight.js"], childEnv);
    fs.mkdirSync(path.join(recruitRoot, "outputs"), { recursive: true });

    console.log("[5/8] 采集 → 去重入库/编号 → 评分 → 草稿");
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, "sample_stage2_jobs.json"), "utf8"));
    const rawRecords = fixture.records.map((row) => ({
      ...row,
      platform: "BOSS",
      job_id: row.job_id,
      detail_status: "ok",
      source_keyword: row.keyword,
      source_page: 1,
    }));
    // 夹具里的销售岗 JD 偏短；补足到“完整 JD”门槛，确保它进入入库后再被评分的硬条件淘汰。
    for (const row of rawRecords) {
      if (row.job_title === "软件销售经理") {
        row.job_description = `${row.job_description} 负责区域客户拜访、商机跟进、合同谈判、回款和渠道伙伴维护，需要长期出差并承担销售指标。`;
      }
    }
    rawRecords.push({
      platform: "BOSS",
      record_key: "boss:test-pending",
      job_id: "test-pending",
      company: "待补公司",
      job_title: "AI项目经理",
      city: "上海",
      salary: "20-30K",
      job_description: "",
      collection_status: "list_api_only",
      detail_status: "list_api_only",
      keyword: "AI项目经理",
      source_keyword: "AI项目经理",
      source_page: 1,
    });
    const rawPath = path.join(recruitRoot, "outputs", "smoke_raw_stage1.json");
    fs.writeFileSync(rawPath, JSON.stringify({ platform: "BOSS", dateKey, records: rawRecords }, null, 2), "utf8");
    const ingestResult = run("ingest", recruitRoot, ["src/ingest/job_ingest.js", rawPath, `--date=${dateKey}`], childEnv);
    const ingest = parseJsonOutput(ingestResult.stdout, "ingest");
    const ingestItem = ingest.results[0];
    assert(ingestItem.jsonPath && fs.existsSync(ingestItem.jsonPath), "ingested JSON missing");
    assert.strictEqual(ingestItem.summary.pending, 1, "list-only record must go pending");
    assert.strictEqual(ingestItem.summary.new_primary, 4, "expected 4 primary jobs");
    const ingestPayload = JSON.parse(fs.readFileSync(ingestItem.jsonPath, "utf8"));
    assert.deepStrictEqual(ingestPayload.records.map((row) => row.display_id), ["A001", "A002", "A003", "A004"]);
    const storeAfterIngest = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.strictEqual(Object.keys(storeAfterIngest.jobs).length, 4);
    const firstIds = Object.fromEntries(Object.entries(storeAfterIngest.jobs).map(([key, entry]) => [key, entry.display_id]));

    const ingestAgainResult = run("ingest again", recruitRoot, ["src/ingest/job_ingest.js", rawPath, `--date=${dateKey}`], childEnv);
    const ingestAgain = parseJsonOutput(ingestAgainResult.stdout, "ingest again");
    assert.strictEqual(ingestAgain.results[0].summary.new_primary, 0, "same-channel duplicate must not create a new record");
    assert.strictEqual(ingestAgain.results[0].summary.updated_existing, 4, "same jobs should be updated, not re-numbered");
    const storeAfterSecond = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.strictEqual(Object.keys(storeAfterSecond.jobs).length, 4, "same-channel duplicate must not add rows");
    for (const [key, displayId] of Object.entries(firstIds)) {
      assert.strictEqual(storeAfterSecond.jobs[key].display_id, displayId, "display id must not be reassigned");
    }

    const scoreResult = run("score", recruitRoot, ["src/evaluate/score_jobs.js", ingestItem.jsonPath, `--date=${dateKey}`, "--no-ai"], childEnv);
    const score = parseJsonOutput(scoreResult.stdout, "score");
    const scoredPayload = JSON.parse(fs.readFileSync(score.jsonPath, "utf8"));
    const sales = scoredPayload.records.find((row) => row.job_title === "软件销售经理");
    assert(sales, "sales job missing after scoring");
    assert.strictEqual(sales.score.hard.status, "fail", "sales title must fail hard condition");
    assert.strictEqual(sales.focus_level, "暂不考虑");
    const javaPm = scoredPayload.records.find((row) => row.job_title === "软件开发项目经理");
    assert(["重点关注", "可关注"].includes(javaPm.focus_level), "strong software job must be recommendable");
    const aiRole = scoredPayload.records.find((row) => row.job_title === "AI应用开发工程师");
    assert(aiRole.role_type_fit_score >= 80, "target role should be recognized");

    const draftResult = run("draft", recruitRoot, ["src/push/job_push_draft_and_send.js", score.jsonPath], childEnv);
    const draft = parseJsonOutput(draftResult.stdout, "draft");
    assert(draft.priorityCount >= 2, "expected at least two draft items");
    assert(draft.messages.every((message) => message.feishu && message.feishu.skipped), "draft mode must not send");
    assert(draft.messages.some((message) => fs.existsSync(message.txtPath)), "draft txt missing");

    console.log("[6/8] 跨渠道重复：保留编号但标记重复，不参与推荐");
    const liepinRaw = {
      platform: "猎聘",
      dateKey,
      records: [{
        platform: "猎聘",
        record_key: "liepin:smoke-1",
        liepin_job_id: "smoke-1",
        company: "云栈科技（测试）",
        job_title: "软件开发项目经理",
        salary: "25-35K·14薪",
        salary_min_k: 25,
        salary_max_k: 35,
        city: "上海",
        district: "徐汇区",
        job_description: fixture.records[0].job_description,
        collection_status: "ok",
        detail_status: "ok",
        keyword: "软件开发项目经理",
        source_keyword: "软件开发项目经理",
        source_page: 1,
      }],
    };
    const liepinRawPath = path.join(recruitRoot, "outputs", "smoke_raw_liepin.json");
    fs.writeFileSync(liepinRawPath, JSON.stringify(liepinRaw, null, 2), "utf8");
    const liepinIngestResult = run("liepin ingest", recruitRoot, ["src/ingest/job_ingest.js", liepinRawPath, `--date=${dateKey}`], childEnv);
    const liepinIngest = parseJsonOutput(liepinIngestResult.stdout, "liepin ingest");
    const liepinPayload = JSON.parse(fs.readFileSync(liepinIngest.results[0].jsonPath, "utf8"));
    assert.strictEqual(liepinPayload.records[0].display_id, "B001");
    assert.strictEqual(liepinPayload.records[0].record_status, "duplicate");
    assert.strictEqual(liepinPayload.records[0].duplicate_of_display_id, "A001");

    console.log("[7/8] 评分规则/AI 边界：硬条件不能被 AI 推翻");
    const aiProbe = [
      "const {scoreJob}=require('./src/evaluate/score_job_facts');",
      "const {applyReview}=require('./src/evaluate/ai_score_review');",
      "const {deliverySignature}=require('./src/push/job_push_draft_and_send');",
      "const {loadCandidateFacts,loadScoringRules}=require('./src/evaluate/candidate_facts');",
      "const {facts,rules}=(()=>{const f=loadCandidateFacts();const r=loadScoringRules();return {facts:f.facts,rules:r.rules};})();",
      "const sales={platform:'BOSS',job_store_key:'probe-sales',company:'销售公司',job_title:'软件销售经理',salary:'15-25K',salary_min_k:15,salary_max_k:25,city:'上海',job_description:'负责软件销售、客户开发、渠道拓展和回款。',collection_status:'ok',detail_status:'ok'};",
      "const failed=scoreJob(sales,facts,rules,{dateKey:'2026-10-28'});",
      "const reviewed=applyReview(failed,{delta:8,reasons:['AI想提升'],risks:[]},{provider:'test',model:'test',maxDelta:8},rules);",
      "const good={platform:'BOSS',job_store_key:'probe-good',company:'技术公司',job_title:'Java后端开发工程师',salary:'25-35K',salary_min_k:25,salary_max_k:35,city:'上海',district:'徐汇区',job_description:'负责Java后端开发、Spring Boot、微服务、MySQL、Redis、接口设计和性能优化，参与需求评审和上线。',collection_status:'ok',detail_status:'ok'};",
      "const goodScore=scoreJob(good,facts,rules,{dateKey:'2026-10-28'});",
      "const goodReviewed=applyReview(goodScore,{delta:50,reasons:['解释'],risks:[]},{provider:'test',model:'test',maxDelta:8},rules);",
      "const sigA=deliverySignature({facts:{content_hash:'same'},overall_fit_score:70});",
      "const sigB=deliverySignature({facts:{content_hash:'same'},overall_fit_score:90});",
      "console.log(JSON.stringify({before:failed.focus_level,after:reviewed.focus_level,overallBefore:failed.overall_fit_score,overallAfter:reviewed.overall_fit_score,goodBefore:goodScore.overall_fit_score,goodAfter:goodReviewed.overall_fit_score,goodDelta:goodReviewed.score.ai.delta,hardAfter:goodReviewed.score.hard.status,sameSignature:sigA===sigB}));",
    ].join("");
    const aiResult = run("ai hard guard", recruitRoot, ["-e", aiProbe], childEnv);
    const aiGuard = parseJsonOutput(aiResult.stdout, "ai hard guard");
    assert.strictEqual(aiGuard.before, "暂不考虑");
    assert.strictEqual(aiGuard.after, "暂不考虑", "AI must not upgrade a hard-fail job");
    assert.strictEqual(aiGuard.overallAfter, aiGuard.overallBefore);
    assert.strictEqual(aiGuard.goodDelta, 8, "AI delta must be clamped");
    assert.strictEqual(aiGuard.goodAfter, Math.min(100, aiGuard.goodBefore + 8));
    assert.strictEqual(aiGuard.hardAfter, "pass");
    assert.strictEqual(aiGuard.sameSignature, true, "score change must not change delivery signature");

    const aiCacheProbe = [
      "(async()=>{",
      "const router=require('./src/core/ai_router');",
      "let calls=0;",
      "router.runAiTask=async()=>{calls+=1;return {ok:true,provider:'fake',model:'fake',text:JSON.stringify({reviews:[{key:'job-1',delta:5,reasons:['fake'],risks:[]}]})};};",
      "const {reviewScores}=require('./src/evaluate/ai_score_review');",
      "const {loadCandidateFacts,loadScoringRules}=require('./src/evaluate/candidate_facts');",
      "const candidate=loadCandidateFacts().facts;const rules=loadScoringRules().rules;",
      "const rows=[",
      "{job_store_key:'job-1',record_status:'active',score:{hard:{status:'pass'},overall:70,success:60,soft:{},reasons:[],risks:[]}},",
      "{job_store_key:'job-2',record_status:'active',focus_level:'暂不考虑',overall_fit_score:90,score:{hard:{status:'fail'},overall:90,success:80,soft:{},reasons:[],risks:[]}},",
      "{job_store_key:'job-3',record_status:'active',focus_level:'低优先',overall_fit_score:30,score:{hard:{status:'pass'},overall:30,success:20,soft:{},reasons:[],risks:[]}}",
      "];",
      "const first=await reviewScores(rows,{rules,candidate,ruleVersion:'r1',candidateVersion:'c1',maxRows:1,minScore:0,maxDelta:8});",
      "const second=await reviewScores(rows,{rules,candidate,ruleVersion:'r1',candidateVersion:'c1',maxRows:1,minScore:0,maxDelta:8});",
      "console.log(JSON.stringify({calls,firstReviewed:first.reviewed,firstCached:first.cached,secondCached:second.cached,job1:second.rows[0].score.ai.delta,job1Focus:second.rows[0].focus_level,job2Focus:second.rows[1].focus_level,job2Overall:second.rows[1].overall_fit_score,job1Reasons:second.rows[0].match_reasons_json}));",
      "})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});",
    ].join("");
    const aiCacheResult = run("ai cache guard", recruitRoot, ["-e", aiCacheProbe], childEnv);
    const aiCache = parseJsonOutput(aiCacheResult.stdout, "ai cache guard");
    assert.strictEqual(aiCache.calls, 1, "second AI review should hit cache");
    assert.strictEqual(aiCache.firstReviewed, 1);
    assert.strictEqual(aiCache.secondCached, 1);
    assert.strictEqual(aiCache.job1, 5);
    assert.strictEqual(aiCache.job2Focus, "暂不考虑", "AI must not review a hard-fail job");
    assert.strictEqual(aiCache.job2Overall, 90, "hard-fail job must keep its rule score");
    assert.match(String(aiCache.job1Reasons || ""), /fake/, "AI reasons must reach the report-facing field");

    console.log("[8/8] 关键词滚动排序与账本汇总");
    const plannerProbe = [
      "const {planKeywords}=require('./src/strategy/keyword_planner');",
      "const levels=[{type:'岗位信息',keywords:['常用词','久未用词']},{type:'宽泛词',keywords:['宽泛词']}];",
      "const profiles={keywords:{'常用词':{keyword:'常用词',first_used_date:'2026-09-01',last_used_date:'2026-10-27',uses:20,channels:{boss:{uses:20,last_used_date:'2026-10-27',last:{date:'2026-10-27',seen:20,new_primary:0,duplicates:20,failures:0},history:[]}}},'久未用词':{keyword:'久未用词',first_used_date:'2026-01-01',last_used_date:'2026-01-01',uses:1,channels:{boss:{uses:1,last_used_date:'2026-01-01',last:{date:'2026-01-01',seen:10,new_primary:6,duplicates:2,failures:0},history:[]}}}}};",
      "const plan=planKeywords({levels,channel:'boss',totalNew:30,profiles,nowDate:'2026-10-28'});",
      "console.log(JSON.stringify(plan));",
    ].join("");
    const plannerResult = run("keyword planner", recruitRoot, ["-e", plannerProbe], childEnv);
    const plan = parseJsonOutput(plannerResult.stdout, "keyword planner");
    assert(plan.length >= 3);
    assert(plan[0].keyword === "久未用词" || plan.findIndex((item) => item.keyword === "久未用词") < plan.findIndex((item) => item.keyword === "常用词"), "long-unused keyword should rank before exhausted keyword");
    assert(plan.every((item) => item.target_new >= 1 && item.max_pages >= 1));

    const ledgerProbe = [
      "const {mergeDay}=require('./src/store/collection_ledger');",
      "const merged=mergeDay([{channel:'BOSS',keyword:'AI项目经理',stage:'collect',seen:10,duplicates:4,new_candidates:3,detail_ok:3,detail_fail:1,pending:1,pages:2,stop_reason:'target'},{channel:'BOSS',keyword:'AI项目经理',stage:'ingest',ingested_primary:2,ingested_duplicate:1,pending_confirmed:1,pages:0,stop_reason:'ingest_done'}]);",
      "console.log(JSON.stringify(merged));",
    ].join("");
    const ledgerResult = run("ledger merge", recruitRoot, ["-e", ledgerProbe], childEnv);
    const merged = parseJsonOutput(ledgerResult.stdout, "ledger merge");
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].seen, 10);
    assert.strictEqual(merged[0].duplicates, 4);
    assert.strictEqual(merged[0].ingested_primary, 2);
    assert.strictEqual(merged[0].pages, 2);

    const refreshProbe = [
      "const {refreshMissingOpenJobs}=require('./src/store/job_store');",
      "const store={jobs:{'boss:old':{platform:'BOSS',job_status:'unknown',first_seen_date:'2026-09-01',last_seen_date:'2026-09-01',missing_since_date:'2026-09-02',not_seen_refresh_count:7}},runs:[]};",
      "const r=refreshMissingOpenJobs(store,['boss:old'],{dateKey:'2026-10-28',now:'2026-10-28 09:00:00',platforms:['boss'],closeAfterDays:7});",
      "console.log(JSON.stringify({status:store.jobs['boss:old'].job_status,lastSeen:store.jobs['boss:old'].last_seen_date,missing:store.jobs['boss:old'].missing_since_date,changed:r.changed.length}));",
    ].join("");
    const refreshResult = run("refresh seen keys", recruitRoot, ["-e", refreshProbe], childEnv);
    const refreshCheck = parseJsonOutput(refreshResult.stdout, "refresh seen keys");
    assert.strictEqual(refreshCheck.status, "open", "seen job must be restored to open");
    assert.strictEqual(refreshCheck.lastSeen, "2026-10-28");
    assert.strictEqual(refreshCheck.missing, "");

    const aiLogPath = path.join(recruitRoot, "logs", "ai_calls.log");
    const aiLog = fs.existsSync(aiLogPath) ? fs.readFileSync(aiLogPath, "utf8") : "";
    assert(!/codex_runtime|openai_api/.test(aiLog), "offline smoke must not call real AI providers");

    console.log(JSON.stringify({
      type: "offline_smoke_v13_result",
      ok: true,
      tempRoot: "(removed)",
      dateKey,
      ingestedPrimary: 4,
      pending: 1,
      crossChannelDuplicate: "B001 -> A001",
      draftPriorityCount: draft.priorityCount,
      aiMode: "disabled",
      sent: false,
    }, null, 2));
  } finally {
    if (keepTemp) console.log(`保留临时目录：${tempRoot}`);
    else removeTempSafely(tempRoot);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
