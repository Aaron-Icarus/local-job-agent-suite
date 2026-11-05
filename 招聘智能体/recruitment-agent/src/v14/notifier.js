const { nowIso } = require("./jobs_repo");

function createNotification(db, input = {}) {
  const result = db.prepare(
    `INSERT INTO notifications(type, title, body, role_uuid, channels_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    String(input.type || "info"),
    String(input.title || ""),
    String(input.body || ""),
    String(input.roleUuid || ""),
    JSON.stringify(input.channels || ["toast", "tray", "feishu"]),
    nowIso()
  );
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(result.lastInsertRowid);
}

async function sendNotification(db, id, senders = {}) {
  const item = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
  if (!item) throw new Error("通知不存在");
  const channels = safeJson(item.channels_json, []);
  const results = [];
  for (const channel of channels) {
    try {
      if (typeof senders[channel] === "function") {
        const result = await senders[channel](item);
        results.push({ channel, ok: result !== false });
      } else {
        results.push({ channel, ok: true, skipped: true });
      }
    } catch (error) {
      results.push({ channel, ok: false, error: error.message });
    }
  }
  const ok = results.every((item) => item.ok);
  db.prepare("UPDATE notifications SET status = ?, sent_at = ?, error = ? WHERE id = ?").run(
    ok ? "sent" : "failed",
    nowIso(),
    JSON.stringify(results),
    id
  );
  return { item, results, ok };
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function listNotifications(db, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  return db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?").all(limit);
}

module.exports = { createNotification, sendNotification, listNotifications };
