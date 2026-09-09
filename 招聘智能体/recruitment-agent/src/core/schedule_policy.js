const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..", "..");
const defaultPolicyPath = path.join(rootDir, "config", "schedule_policy.json");

function configuredPolicyPath() {
  const value = process.env.SCHEDULE_POLICY_PATH || defaultPolicyPath;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function timeToMinutes(value, label = "time") {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`${label} must use HH:mm format: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} is outside a valid day: ${value}`);
  return hour * 60 + minute;
}

function validateSchedulePolicy(policy) {
  const issues = [];
  if (!policy || typeof policy !== "object") return ["调度配置不是有效的 JSON 对象。"];
  if (policy.timezone !== "Asia/Shanghai") issues.push("timezone 当前必须为 Asia/Shanghai。");
  const windows = Array.isArray(policy.collection_windows) ? policy.collection_windows : [];
  if (!windows.length) issues.push("collection_windows 至少需要一个采集时间段。");
  const ids = new Set();
  const allTriggers = new Set();
  const windowRanges = [];
  for (const window of windows) {
    if (!window?.id || ids.has(window.id)) issues.push(`采集时间段 id 缺失或重复：${window?.id || "(空)"}。`);
    ids.add(window?.id);
    try {
      const start = timeToMinutes(window.start, `${window.id}.start`);
      const end = timeToMinutes(window.end, `${window.id}.end`);
      if (start >= end) issues.push(`${window.id} 的 start 必须早于 end。`);
      windowRanges.push({ id: window.id, start, end });
      if (Number(window.max_successful_runs) !== 1) issues.push(`${window.id}.max_successful_runs 当前只支持 1。`);
      if (!Array.isArray(window.trigger_times) || !window.trigger_times.length) issues.push(`${window.id} 缺少 trigger_times。`);
      for (const time of window.trigger_times || []) {
        const minute = timeToMinutes(time, `${window.id}.trigger_times`);
        if (minute < start || minute >= end) issues.push(`${window.id} 触发时间 ${time} 不在该时间段内。`);
        if (allTriggers.has(time)) issues.push(`触发时间重复：${time}。`);
        allTriggers.add(time);
      }
    } catch (error) {
      issues.push(error.message);
    }
  }
  const sortedRanges = windowRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < sortedRanges.length; index += 1) {
    if (sortedRanges[index].start < sortedRanges[index - 1].end) {
      issues.push(`采集时间段重叠：${sortedRanges[index - 1].id} 与 ${sortedRanges[index].id}。`);
    }
  }
  if (!Number.isFinite(Number(policy.minimum_collection_gap_hours)) || Number(policy.minimum_collection_gap_hours) <= 0) {
    issues.push("minimum_collection_gap_hours 必须是大于 0 的小时数。");
  }
  if (!Array.isArray(policy.collection_completion_statuses) || !policy.collection_completion_statuses.includes("success")) {
    issues.push("collection_completion_statuses 必须至少包含 success；只有列出的状态会占用半天成功配额。");
  }
  const report = policy.report_window || {};
  try {
    const start = timeToMinutes(report.start, "report_window.start");
    const end = timeToMinutes(report.end, "report_window.end");
    if (start >= end) issues.push("report_window.start 必须早于 end。");
    if (!Array.isArray(report.trigger_times) || !report.trigger_times.length) issues.push("report_window 缺少 trigger_times。");
    for (const time of report.trigger_times || []) {
      const minute = timeToMinutes(time, "report_window.trigger_times");
      if (minute < start || minute >= end) issues.push(`日报触发时间 ${time} 不在日报窗口内。`);
      if (allTriggers.has(time)) issues.push(`触发时间重复：${time}。`);
      allTriggers.add(time);
    }
    if (!Number.isFinite(Number(report.retry_gap_minutes)) || Number(report.retry_gap_minutes) <= 0) issues.push("report_window.retry_gap_minutes 必须大于 0。");
    if (!Number.isFinite(Number(report.collect_if_last_success_older_than_hours)) || Number(report.collect_if_last_success_older_than_hours) <= 0) {
      issues.push("report_window.collect_if_last_success_older_than_hours 必须大于 0。");
    }
  } catch (error) {
    issues.push(error.message);
  }
  try {
    if (typeof policy.watchdog?.enabled !== "boolean") issues.push("watchdog.enabled 必须是 true 或 false。");
    if (policy.watchdog?.enabled) {
      const watchdogTime = timeToMinutes(policy.watchdog.time, "watchdog.time");
      if (report.end && watchdogTime <= timeToMinutes(report.end, "report_window.end")) issues.push("watchdog.time 必须晚于日报窗口结束时间。");
    }
  } catch (error) {
    issues.push(error.message);
  }
  if (policy.windows_task?.wake_computer !== false) issues.push("windows_task.wake_computer 必须为 false：本项目约定不唤醒电脑。");
  if (policy.windows_task?.start_when_available !== false) issues.push("windows_task.start_when_available 必须为 false：本项目约定错过不补跑。");
  if (policy.windows_task?.multiple_instances !== "IgnoreNew") issues.push("windows_task.multiple_instances 必须为 IgnoreNew，避免两轮同时抢浏览器。");
  return issues;
}

function loadSchedulePolicy(filePath = configuredPolicyPath()) {
  if (!fs.existsSync(filePath)) throw new Error(`Schedule policy not found: ${filePath}`);
  const policy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const issues = validateSchedulePolicy(policy);
  if (issues.length) throw new Error(`Invalid schedule policy:\n- ${issues.join("\n- ")}`);
  return { policy, filePath };
}

function slotForParts(parts, policy) {
  const minutes = parts.hour * 60 + parts.minute;
  for (const window of policy.collection_windows) {
    if (minutes >= timeToMinutes(window.start) && minutes < timeToMinutes(window.end)) return window.id;
  }
  const report = policy.report_window;
  if (minutes >= timeToMinutes(report.start) && minutes < timeToMinutes(report.end)) return "delivery";
  return "outside";
}

function allMainTriggerTimes(policy) {
  return [
    ...policy.collection_windows.flatMap((window) => window.trigger_times),
    ...policy.report_window.trigger_times,
  ];
}

module.exports = {
  configuredPolicyPath,
  timeToMinutes,
  validateSchedulePolicy,
  loadSchedulePolicy,
  slotForParts,
  allMainTriggerTimes,
};
