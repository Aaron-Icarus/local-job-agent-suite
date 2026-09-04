const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadEnv, envBool } = require("../core/load_env");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const dataDir = path.join(rootDir, "data");
const logDir = path.join(rootDir, "logs");
const statePath = path.join(dataDir, "schedule_state.json");
const args = new Set(process.argv.slice(2));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function loadState() {
  if (!fs.existsSync(statePath)) return { collectRuns: [], reportRuns: [] };
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state) {
  ensureDir(dataDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function appendLog(message, detail = {}) {
  ensureDir(logDir);
  const entry = { at: new Date().toISOString(), message, ...detail };
  fs.appendFileSync(path.join(logDir, "scheduled_entry.log"), `${JSON.stringify(entry)}\n`, "utf8");
  console.log(JSON.stringify(entry));
}

function slotFor(parts) {
  const minutes = parts.hour * 60 + parts.minute;
  const reportStart = Number(process.env.SCHEDULE_REPORT_START_HOUR || 19) * 60;
  const reportEnd = Number(process.env.SCHEDULE_REPORT_END_HOUR || 21) * 60;
  if (minutes >= 7 * 60 && minutes < 12 * 60) return "morning";
  if (minutes >= 12 * 60 && minutes < 16 * 60) return "afternoon";
  if (minutes >= 16 * 60 && minutes < reportStart) return "pre_report";
  if (minutes >= reportStart && minutes < reportEnd) return "delivery";
  return "outside";
}

function lastSuccessfulRun(state) {
  return [...(state.collectRuns || [])]
    .filter((run) => ["success", "partial_success"].includes(run.status))
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
}

function hasSuccessfulEveningReport(state, dateKey) {
  return (state.reportRuns || []).some((run) => run.dateKey === dateKey && run.status === "success");
}

function lastReportAttempt(state, dateKey) {
  return [...(state.reportRuns || [])]
    .filter((run) => run.dateKey === dateKey)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
}

function hasFinalizedReportAttempt(state, dateKey) {
  return (state.reportRuns || []).some((run) => run.dateKey === dateKey && ["success", "partial_success", "failed"].includes(run.status));
}

function elapsedHoursSince(run, now) {
  if (!run) return Infinity;
  return (now.getTime() - new Date(run.at).getTime()) / 3600000;
}

function decide(state, now = new Date()) {
  if (envBool("FORCE_SCHEDULE_RUN", false)) {
    return { shouldRun: true, action: "collect_and_report", slot: "forced", reason: "FORCE_SCHEDULE_RUN=true" };
  }
  const parts = shanghaiParts(now);
  const slot = slotFor(parts);
  const todaysRuns = (state.collectRuns || []).filter((run) => run.dateKey === parts.dateKey && run.status === "success");
  const minGapHours = Number(process.env.SCHEDULE_MIN_COLLECTION_GAP_HOURS || 2);
  const lastToday = [...todaysRuns].sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  const gapSatisfied = elapsedHoursSince(lastToday, now) >= minGapHours;
  if (slot === "morning") {
    const exists = todaysRuns.some((run) => run.slot === "morning");
    return {
      shouldRun: !exists,
      action: exists ? "skip" : "collect_only",
      slot,
      dateKey: parts.dateKey,
      reason: exists ? "morning already collected" : "morning collection due"
    };
  }
  if (slot === "afternoon") {
    const exists = todaysRuns.some((run) => run.slot === "afternoon");
    return {
      shouldRun: !exists && gapSatisfied,
      action: exists || !gapSatisfied ? "skip" : "collect_only",
      slot,
      dateKey: parts.dateKey,
      reason: exists ? "afternoon already collected" : (!gapSatisfied ? `minimum ${minGapHours}h collection gap not reached` : "afternoon collection due")
    };
  }
  if (slot === "pre_report") {
    const afternoon = todaysRuns.find((run) => run.slot === "afternoon");
    const exists = todaysRuns.some((run) => run.slot === "pre_report");
    return {
      shouldRun: Boolean(afternoon && !exists && gapSatisfied),
      action: afternoon && !exists && gapSatisfied ? "collect_only" : "skip",
      slot,
      dateKey: parts.dateKey,
      reason: !afternoon ? "no afternoon collection to refresh" : (exists ? "pre-report collection already completed" : (!gapSatisfied ? `minimum ${minGapHours}h collection gap not reached` : "afternoon data is early; refresh before delivery"))
    };
  }
  if (slot === "delivery") {
    if (hasSuccessfulEveningReport(state, parts.dateKey)) {
      return {
        shouldRun: false,
        action: "skip",
        slot,
        dateKey: parts.dateKey,
        reason: "daily report already delivered"
      };
    }
    const previousReport = lastReportAttempt(state, parts.dateKey);
    if (previousReport && ["partial_success", "failed"].includes(previousReport.status)) {
      const retryGapMinutes = Number(process.env.SCHEDULE_REPORT_RETRY_GAP_MINUTES || 30);
      const elapsedMinutes = elapsedHoursSince(previousReport, now) * 60;
      if (elapsedMinutes < retryGapMinutes) {
        return {
          shouldRun: false,
          action: "skip",
          slot,
          dateKey: parts.dateKey,
          reason: `previous report ${previousReport.status}; wait ${retryGapMinutes} minutes before retry`,
          lastReportAt: previousReport.at,
          elapsedMinutes: Number(elapsedMinutes.toFixed(1))
        };
      }
      return {
        shouldRun: true,
        action: "collect_and_report",
        slot,
        dateKey: parts.dateKey,
        reason: `previous report ${previousReport.status}; retry before 21:00`,
        lastReportAt: previousReport.at,
        elapsedMinutes: Number(elapsedMinutes.toFixed(1))
      };
    }
    if (!lastToday) {
      return {
        shouldRun: true,
        action: "collect_and_report",
        slot,
        dateKey: parts.dateKey,
        reason: "no successful collection today; collect before delayed delivery"
      };
    }
    const elapsedHours = elapsedHoursSince(lastToday, now);
    return {
      shouldRun: true,
      action: elapsedHours >= 2 ? "collect_and_report" : "report_only",
      slot,
      dateKey: parts.dateKey,
      reason: elapsedHours >= 2 ? "last collection is over 2 hours ago; collect before report" : "last collection is within 2 hours; report directly",
      lastRunAt: lastToday.at,
      elapsedHours: Number(elapsedHours.toFixed(2))
    };
  }
  return { shouldRun: false, action: "skip", slot, dateKey: parts.dateKey, reason: "outside collection windows" };
}

function testNow() {
  if (!process.env.SCHEDULE_TEST_NOW) return new Date();
  const parsed = new Date(process.env.SCHEDULE_TEST_NOW);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid SCHEDULE_TEST_NOW: ${process.env.SCHEDULE_TEST_NOW}`);
  return parsed;
}

function runWorkflow(decision) {
  const collect = decision.action === "collect_only" || decision.action === "collect_and_report";
  const report = decision.action === "report_only" || decision.action === "collect_and_report";
  const env = {
    ...process.env,
    ENABLE_BOSS: process.env.ENABLE_BOSS || "true",
    ENABLE_LIEPIN: process.env.ENABLE_LIEPIN || "false",
    ENABLE_COLLECT: collect ? "true" : "false",
    ENABLE_LOGIN_CHECK: process.env.ENABLE_LOGIN_CHECK || "true",
    ENABLE_SCREEN: report ? "true" : "false",
    ENABLE_EVALUATE: report ? "true" : "false",
    ENABLE_PUSH: report ? "true" : "false",
    SEND_MODE: report ? (process.env.SCHEDULE_SEND_MODE || "send") : "draft",
    MAX_TOTAL: process.env.SCHEDULE_MAX_TOTAL || process.env.MAX_TOTAL || "50",
    PER_KEYWORD: process.env.SCHEDULE_PER_KEYWORD || process.env.PER_KEYWORD || "8",
    LIEPIN_MAX_TOTAL: process.env.SCHEDULE_LIEPIN_MAX_TOTAL || process.env.LIEPIN_MAX_TOTAL || process.env.SCHEDULE_MAX_TOTAL || process.env.MAX_TOTAL || "30",
    LIEPIN_PER_KEYWORD: process.env.SCHEDULE_LIEPIN_PER_KEYWORD || process.env.LIEPIN_PER_KEYWORD || process.env.SCHEDULE_PER_KEYWORD || process.env.PER_KEYWORD || "5"
  };
  const timeoutMs = Number(process.env.SCHEDULE_WORKFLOW_TIMEOUT_MINUTES || 45) * 60 * 1000;
  appendLog("workflow dispatch", {
    decision,
    action: decision.action,
    sendMode: env.SEND_MODE,
    maxTotal: env.MAX_TOTAL,
    perKeyword: env.PER_KEYWORD,
    timeoutMinutes: timeoutMs / 60000
  });
  const result = spawnSync(process.execPath, ["src/main/daily_workflow.js"], {
    cwd: rootDir,
    encoding: "utf8",
    env,
    timeout: timeoutMs
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function main() {
  const state = loadState();
  const decision = decide(state, testNow());
  appendLog("schedule decision", decision);
  if (args.has("--decision-only")) {
    return;
  }
  if (!decision.shouldRun) {
    return;
  }
  const startedAt = new Date().toISOString();
  const result = runWorkflow(decision);
  const finishedAt = new Date().toISOString();
  const runRecord = {
    at: finishedAt,
    startedAt,
    dateKey: decision.dateKey || shanghaiParts().dateKey,
    slot: decision.slot,
    action: decision.action,
    status: result.status === 0 ? "success" : result.status === 2 ? "partial_success" : "failed",
    exitCode: result.status
  };
  state.collectRuns = state.collectRuns || [];
  state.reportRuns = state.reportRuns || [];
  if (decision.action === "collect_only" || decision.action === "collect_and_report") {
    state.collectRuns.push(runRecord);
  }
  if (decision.action === "report_only" || decision.action === "collect_and_report") {
    state.reportRuns.push(runRecord);
  }
  state.collectRuns = state.collectRuns.slice(-100);
  state.reportRuns = state.reportRuns.slice(-100);
  saveState(state);
  appendLog("schedule run recorded", runRecord);
  if (result.status !== 0) process.exitCode = result.status || 1;
}

if (require.main === module) main();

module.exports = { decide, slotFor, shanghaiParts, hasFinalizedReportAttempt };
