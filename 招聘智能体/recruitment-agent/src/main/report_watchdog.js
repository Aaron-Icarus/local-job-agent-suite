const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadEnv } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { sendRecruitmentNotification, isDelivered } = require("../push/outbound_sender");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const logPath = path.join(rootDir, "logs", "report_watchdog.log");

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function appendLog(entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

function dateKeyForIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : shanghaiDateKey(date);
}

function inspectDailyReport(dateKey = shanghaiDateKey()) {
  const scheduleState = readJson(path.join(rootDir, "data", "schedule_state.json"), { reportRuns: [] });
  const pushState = readJson(path.join(rootDir, "data", "push_state.json"), { reports: [] });
  const successfulRun = (scheduleState.reportRuns || []).find((run) => run.dateKey === dateKey && run.status === "success") || null;
  const deliveryReports = (pushState.reports || []).filter((report) => dateKeyForIso(report.at) === dateKey && report.sendMode === "send");
  const deliveredMessages = deliveryReports.flatMap((report) => report.messages || []).filter((message) => message.delivered === true);
  return { dateKey, successfulRun, deliveryReports, deliveredMessages };
}

function inspectTaskRegistration() {
  if (process.platform !== "win32" || /^(1|true|yes)$/i.test(process.env.SKIP_TASK_HEALTH_CHECK || "")) {
    return { ok: true, skipped: true, reason: "non-Windows or explicitly skipped" };
  }
  const script = path.join(rootDir, "bin", "verify_windows_tasks.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Json"];
  if (process.env.SCHEDULE_TASK_NAME) args.push("-TaskName", process.env.SCHEDULE_TASK_NAME);
  if (process.env.WATCHDOG_TASK_NAME) args.push("-WatchdogTaskName", process.env.WATCHDOG_TASK_NAME);
  const result = spawnSync("powershell.exe", args, { cwd: rootDir, encoding: "utf8", timeout: 30000 });
  const line = String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return { ok: false, issues: [String(result.stderr || result.stdout || "计划任务校验无输出").trim()] }; }
}

async function main() {
  const dateKey = process.env.WATCHDOG_DATE || shanghaiDateKey();
  const report = inspectDailyReport(dateKey);
  const taskHealth = inspectTaskRegistration();
  const reasons = [];
  if (!report.successfulRun) reasons.push("没有当日日报成功记录");
  if (String(process.env.SCHEDULE_SEND_MODE || "draft").toLowerCase() === "send" && !report.deliveredMessages.length) reasons.push("没有当日真实发送回执");
  if (!taskHealth.ok) reasons.push(`计划任务配置异常：${(taskHealth.issues || []).join("；")}`);
  if (!reasons.length) {
    appendLog({ status: "ok", dateKey, deliveredMessages: report.deliveredMessages.length, taskHealth });
    console.log(JSON.stringify({ ok: true, dateKey, deliveredMessages: report.deliveredMessages.length, taskHealth }));
    return;
  }
  const text = `【招聘日报缺失告警】${dateKey} 21:05 独立检查未通过：${reasons.join("；")}。请检查 Windows 计划任务、logs/scheduled_entry.log 和 data/push_state.json。`;
  const mode = String(process.env.WATCHDOG_SEND_MODE || "draft").toLowerCase();
  let delivery = { skipped: true, reason: `WATCHDOG_SEND_MODE=${mode}` };
  if (mode === "send") {
    delivery = await sendRecruitmentNotification(text, { topic: "recruitment_watchdog", idempotency_key: `recruitment-watchdog:${dateKey}` });
  }
  appendLog({ status: "alert", dateKey, reasons, mode, delivered: isDelivered(delivery), delivery, taskHealth });
  console.log(JSON.stringify({ ok: false, dateKey, reasons, mode, delivered: isDelivered(delivery), taskHealth }));
  if (mode === "send" && !isDelivered(delivery)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  appendLog({ status: "failed", error: error.stack || error.message });
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { inspectDailyReport, inspectTaskRegistration };
