const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadEnv, envBool } = require("../core/load_env");
const { loadSchedulePolicy, slotForParts } = require("../core/schedule_policy");

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

function slotFor(parts, policy = loadSchedulePolicy().policy) {
  return slotForParts(parts, policy);
}

function lastSuccessfulRun(state, policy = loadSchedulePolicy().policy) {
  const completionStatuses = new Set(policy.collection_completion_statuses || ["success"]);
  return [...(state.collectRuns || [])]
    .filter((run) => completionStatuses.has(run.status))
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
}

function isUsableCollectionRun(run, policy = loadSchedulePolicy().policy) {
  return (policy.collection_completion_statuses || ["success"]).includes(run?.status);
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

function decide(state, now = new Date(), policy = loadSchedulePolicy().policy) {
  if (envBool("FORCE_SCHEDULE_RUN", false)) {
    return { shouldRun: true, action: "collect_and_report", slot: "forced", reason: "FORCE_SCHEDULE_RUN=true" };
  }
  const parts = shanghaiParts(now);
  const slot = slotFor(parts, policy);
  const todaysRuns = (state.collectRuns || []).filter((run) => run.dateKey === parts.dateKey && isUsableCollectionRun(run, policy));
  const minGapHours = Number(policy.minimum_collection_gap_hours || 2);
  const lastToday = [...todaysRuns].sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  const gapSatisfied = elapsedHoursSince(lastToday, now) >= minGapHours;
  const collectionWindow = policy.collection_windows.find((window) => window.id === slot);
  if (collectionWindow) {
    const completedCount = todaysRuns.filter((run) => run.slot === slot).length;
    const quotaReached = completedCount >= Number(collectionWindow.max_successful_runs || 1);
    const shouldRun = !quotaReached && gapSatisfied;
    return {
      shouldRun,
      action: shouldRun ? "collect_only" : "skip",
      slot,
      dateKey: parts.dateKey,
      reason: quotaReached
        ? `${slot} successful collection quota reached`
        : (!gapSatisfied ? `minimum ${minGapHours}h collection gap not reached` : `${slot} collection due`)
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
    let retryReason = "";
    if (previousReport && ["partial_success", "failed"].includes(previousReport.status)) {
      const retryGapMinutes = Number(policy.report_window.retry_gap_minutes || 30);
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
      retryReason = `previous report ${previousReport.status}; retry before ${policy.report_window.end}`;
    }
    if (!lastToday) {
      return {
        shouldRun: true,
        action: "collect_and_report",
        slot,
        dateKey: parts.dateKey,
        reason: retryReason || "no successful collection today; collect before report"
      };
    }
    const elapsedHours = elapsedHoursSince(lastToday, now);
    const reportCollectionGap = Number(policy.report_window.collect_if_last_success_older_than_hours || 2);
    const collectBeforeReport = elapsedHours >= reportCollectionGap;
    return {
      shouldRun: true,
      action: collectBeforeReport ? "collect_and_report" : "report_only",
      slot,
      dateKey: parts.dateKey,
      reason: retryReason || (collectBeforeReport
        ? `last successful collection is at least ${reportCollectionGap} hours old; collect before report`
        : `last successful collection is newer than ${reportCollectionGap} hours; report directly`),
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

function scheduledSendMode() {
  const mode = String(process.env.SCHEDULE_SEND_MODE || "draft").trim().toLowerCase();
  if (!["draft", "send"].includes(mode)) {
    throw new Error(`Invalid SCHEDULE_SEND_MODE: ${process.env.SCHEDULE_SEND_MODE}. Expected draft or send.`);
  }
  return mode;
}

function runWorkflow(decision) {
  const collect = decision.action === "collect_only" || decision.action === "collect_and_report";
  const report = decision.action === "report_only" || decision.action === "collect_and_report";
  const env = {
    ...process.env,
    ENABLE_COLLECT: collect ? "true" : "false",
    ENABLE_LOGIN_CHECK: process.env.ENABLE_LOGIN_CHECK || "true",
    ENABLE_SCREEN: report ? "true" : "false",
    ENABLE_EVALUATE: report ? "true" : "false",
    ENABLE_PUSH: report ? "true" : "false",
    // A missing setting must never turn a scheduled run into a real send.
    // The operator has to opt in explicitly with SCHEDULE_SEND_MODE=send.
    SEND_MODE: report ? scheduledSendMode() : "draft",
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

function statusForWorkflowResult(result) {
  if (result.status === 0) return "success";
  if (result.status === 2) return "partial_success";
  if (result.status === 3) return "skipped_locked";
  return "failed";
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
    status: statusForWorkflowResult(result),
    exitCode: result.status
  };
  if (runRecord.status !== "skipped_locked") {
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
  }
  appendLog("schedule run recorded", runRecord);
  if (result.status !== 0 && result.status !== 3) process.exitCode = result.status || 1;
}

if (require.main === module) main();

module.exports = { decide, slotFor, shanghaiParts, hasFinalizedReportAttempt, isUsableCollectionRun, lastSuccessfulRun, scheduledSendMode };
