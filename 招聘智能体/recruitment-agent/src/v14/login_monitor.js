const { nowIso } = require("./jobs_repo");

const PLATFORMS = ["BOSS", "猎聘"];

function lastCheck(db, platform) {
  return db.prepare(
    "SELECT * FROM login_checks WHERE platform = ? ORDER BY checked_at DESC LIMIT 1"
  ).get(platform) || null;
}

function shouldCheck(platform, options = {}) {
  const last = options.last || null;
  const now = options.now ? new Date(options.now) : new Date();
  const hours = Number(options.hours || 12);
  if (!last || !last.checked_at) return true;
  const lastAt = new Date(last.checked_at);
  if (Number.isNaN(lastAt.getTime())) return true;
  return now - lastAt >= hours * 3600000;
}

function recordCheck(db, platform, status, error = "", checkedAt = nowIso()) {
  db.prepare(
    "INSERT INTO login_checks(platform, status, checked_at, error) VALUES(?, ?, ?, ?)"
  ).run(platform, status, checkedAt, String(error || "").slice(0, 1000));
  return lastCheck(db, platform);
}

async function runLoginChecks(db, options = {}) {
  const checker = options.check;
  if (typeof checker !== "function") throw new Error("缺少登录检查函数");
  const platforms = options.platforms || PLATFORMS;
  const results = [];
  for (const platform of platforms) {
    const last = lastCheck(db, platform);
    if (!shouldCheck(platform, { last, hours: options.hours, now: options.now })) {
      results.push({ platform, skipped: true, status: last.status, checkedAt: last.checked_at });
      continue;
    }
    try {
      const result = await checker(platform);
      const status = result && result.ok ? "logged_in" : "login_required";
      const checkedAt = options.now ? new Date(options.now).toISOString() : nowIso();
      results.push({ platform, skipped: false, ...recordCheck(db, platform, status, result?.error || "", checkedAt) });
    } catch (error) {
      const checkedAt = options.now ? new Date(options.now).toISOString() : nowIso();
      results.push({ platform, skipped: false, ...recordCheck(db, platform, "error", error.message, checkedAt) });
    }
  }
  return results;
}

function loginStatus(db) {
  return PLATFORMS.map((platform) => ({
    platform,
    last: lastCheck(db, platform),
    due: shouldCheck(platform, { last: lastCheck(db, platform) }),
  }));
}

module.exports = { PLATFORMS, lastCheck, shouldCheck, recordCheck, runLoginChecks, loginStatus };
