const { shanghaiDateKey } = require("../core/time_utils");
const { minutesOfDay } = require("./settings_repo");

function parseDateTime(dateKey, minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return new Date(`${dateKey}T${hh}:${mm}:00+08:00`);
}

function defaultState() {
  return {
    executedCount: 0,
    lastRunAt: "",
    pendingRaw: 0,
    pendingScores: 0,
    reportSent: false,
    idleAllowed: false,
  };
}

function dayAllowed(settings, date) {
  const mode = String(settings.collection_days || "all");
  const weekday = date.getDay(); // 0 Sunday
  if (mode === "all") return true;
  if (mode === "weekdays") return weekday >= 1 && weekday <= 5;
  try {
    const days = JSON.parse(String(settings.collection_days || "[]"));
    return Array.isArray(days) ? days.map(Number).includes(weekday) : true;
  } catch {
    return true;
  }
}

function evaluateSchedule(input = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const settings = input.settings || {};
  const state = { ...defaultState(), ...(input.state || {}) };
  const dateKey = shanghaiDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(settings.collection_start) ?? 9 * 60;
  const end = minutesOfDay(settings.collection_end) ?? 18 * 60;
  const reportStart = minutesOfDay(settings.report_window_start) ?? 19 * 60;
  const reportEnd = minutesOfDay(settings.report_window_end) ?? 22 * 60;
  const report = minutesOfDay(settings.report_time) ?? 21 * 60;
  const preReportStart = report - 120;
  const reportPrepStart = report - 60;
  const result = {
    dateKey,
    nowMinutes,
    inCollectionWindow: nowMinutes >= start && nowMinutes <= end,
    preReportWindow: nowMinutes >= preReportStart && nowMinutes < reportPrepStart,
    reportPrepWindow: nowMinutes >= reportPrepStart && nowMinutes < report,
    reportDue: nowMinutes >= report && !state.reportSent,
    shouldCollect: false,
    shouldIngest: Number(state.pendingRaw || 0) > 0,
    shouldScore: false,
    force: false,
    forceReason: "",
    blockedByInterval: false,
    reason: "",
  };

  if (!dayAllowed(settings, now)) {
    result.reason = "not_collection_day";
    return result;
  }

  if (result.reportPrepWindow || nowMinutes >= report) {
    result.shouldScore = Number(state.pendingScores || 0) > 0;
    result.reason = result.reportPrepWindow ? "report_prep" : "after_report";
    return result;
  }

  const minRuns = Math.max(1, Number(settings.min_collection_runs || 2));
  const intervalHours = Math.max(1, Number(settings.min_interval_hours || 3));
  const lastRun = state.lastRunAt ? new Date(state.lastRunAt) : null;
  const intervalOk = !lastRun || now - lastRun >= intervalHours * 3600000;

  let forceReason = "";
  if (result.preReportWindow && settings.allow_pre_report_collection !== false) {
    if (Number(state.executedCount || 0) === 0) {
      forceReason = settings.collect_at_ingest === true
        ? "pre_report_collect_at_ingest"
        : "pre_report_daily_minimum";
    } else if (settings.collect_at_ingest === true) {
      forceReason = "pre_report_collect_at_ingest";
    }
  } else if (
    result.inCollectionWindow &&
    nowMinutes >= 12 * 60 + 30 &&
    Number(state.executedCount || 0) === 0
  ) {
    forceReason = "checkpoint_1230";
  } else if (
    result.inCollectionWindow &&
    nowMinutes >= Math.max(start, end - 60) &&
    Number(state.executedCount || 0) < minRuns
  ) {
    forceReason = "window_end_minimum";
  }

  if (forceReason) {
    if (!intervalOk) {
      result.blockedByInterval = true;
      result.reason = "forced_but_interval_less_than_1h";
      return result;
    }
    result.shouldCollect = true;
    result.force = true;
    result.forceReason = forceReason;
    result.reason = forceReason;
    return result;
  }

  if (!result.inCollectionWindow) {
    result.reason = "outside_collection_window";
    return result;
  }
  if (Number(state.executedCount || 0) >= minRuns) {
    result.reason = "minimum_runs_reached";
    return result;
  }
  if (!intervalOk) {
    result.blockedByInterval = true;
    result.reason = "interval_less_than_1h";
    return result;
  }
  if (!state.idleAllowed) {
    result.reason = "not_idle";
    return result;
  }
  result.shouldCollect = true;
  result.reason = "idle_window";
  return result;
}

function isReportDue(now, settings, reportSent = false) {
  if (reportSent) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= (minutesOfDay(settings.report_time) ?? 21 * 60);
}

module.exports = {
  parseDateTime,
  dayAllowed,
  evaluateSchedule,
  isReportDue,
};
