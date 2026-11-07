const { nowIso } = require("./jobs_repo");

const DEFAULTS = Object.freeze({
  collection_days: "weekdays",
  collection_start: "09:00",
  collection_end: "18:00",
  min_collection_runs: 2,
  min_interval_hours: 3,
  max_per_hour: 1,
  report_window_start: "19:00",
  report_window_end: "22:00",
  report_time: "21:00",
  collect_at_ingest: false,
  allow_pre_report_collection: true,
  idle_minutes: 5,
  cpu_max_percent: 30,
  battery_min_percent: 30,
  idle_hard_policy: false,
  login_check_hours: 12,
  max_roles: 3,
  raw_retention_days: 30,
  recheck_min_age_days: 7,
  recheck_interval_hours: 24,
});

function minutesOfDay(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function getSettings(db) {
  const rows = db.prepare("SELECT key, value_json FROM settings").all();
  const settings = { ...DEFAULTS };
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value_json);
    } catch {
      // keep default for corrupt value
    }
  }
  return settings;
}

function validateSettings(input) {
  const settings = { ...DEFAULTS, ...(input || {}) };
  const warnings = [];
  const autoFixed = {};

  const interval = Number(settings.min_interval_hours);
  if (!Number.isFinite(interval) || interval < 1) {
    settings.min_interval_hours = 1;
    autoFixed.min_interval_hours = 1;
    warnings.push("采集最小间隔不能低于 1 小时，已自动改为 1 小时");
  }
  const maxPerHour = Number(settings.max_per_hour);
  if (!Number.isFinite(maxPerHour) || maxPerHour > 1) {
    settings.max_per_hour = 1;
    autoFixed.max_per_hour = 1;
    warnings.push("采集频率最高为每小时 1 次，已自动改为 1 次");
  }
  const runs = Number(settings.min_collection_runs);
  if (!Number.isFinite(runs) || runs < 1) {
    settings.min_collection_runs = 1;
    autoFixed.min_collection_runs = 1;
    warnings.push("最低采集次数至少为 1，已自动改为 1");
  }

  const start = minutesOfDay(settings.collection_start);
  const end = minutesOfDay(settings.collection_end);
  const reportStart = minutesOfDay(settings.report_window_start);
  const reportEnd = minutesOfDay(settings.report_window_end);
  const report = minutesOfDay(settings.report_time);
  if (start == null || end == null || end <= start) {
    warnings.push("采集时间段不合法");
  }
  if (reportStart == null || reportEnd == null || reportEnd <= reportStart) {
    warnings.push("日报窗口不合法");
  } else if (report == null || report < reportStart || report > reportEnd) {
    warnings.push("日报时间必须落在日报窗口内");
  }

  if (start != null && end != null && end > start) {
    const available = end - start;
    const required = (Number(settings.min_collection_runs) - 1) * Number(settings.min_interval_hours) * 60;
    if (required > available) {
      warnings.push("当前采集时段放不下最低采集次数和最小间隔，请调整");
    }
  }

  return { settings, warnings, autoFixed };
}

function saveSettings(db, input) {
  const result = validateSettings(input);
  const now = nowIso();
  const statement = db.prepare(
    `INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, value] of Object.entries(result.settings)) {
      statement.run(key, JSON.stringify(value), now);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }
  return result;
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULTS,
  minutesOfDay,
  getSettings,
  validateSettings,
  saveSettings,
};
