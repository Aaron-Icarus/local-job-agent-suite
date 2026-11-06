const crypto = require("crypto");
const { nowIso } = require("./jobs_repo");
const { sendFeishuText } = require("./feishu_sender");
const { createNotification } = require("./notifier");
const messagePlatform = require("./message_platform_service");

const MAX_GROUPS = 10;

function mapGroup(db, row) {
  const roles = db.prepare(
    "SELECT role_uuid, notify_login, notify_error, notify_daily FROM feishu_group_roles WHERE group_id = ?"
  ).all(row.id).map((item) => ({
    role_uuid: item.role_uuid,
    notify_login: Boolean(item.notify_login),
    notify_error: Boolean(item.notify_error),
    notify_daily: Boolean(item.notify_daily),
  }));
  return { ...row, enabled: Boolean(row.enabled), roles };
}

function listGroups(db) {
  return db.prepare("SELECT * FROM feishu_groups ORDER BY created_at ASC").all().map((row) => mapGroup(db, row));
}

function getGroup(db, id) {
  const row = db.prepare("SELECT * FROM feishu_groups WHERE id = ?").get(id);
  return row ? mapGroup(db, row) : null;
}

function saveGroup(db, input = {}) {
  const id = String(input.id || crypto.randomUUID());
  const existing = db.prepare("SELECT * FROM feishu_groups WHERE id = ?").get(id);
  if (!existing && listGroups(db).length >= MAX_GROUPS) throw new Error(`最多只能接入 ${MAX_GROUPS} 个飞书群`);
  const chatId = String(input.chatId || input.chat_id || existing?.chat_id || "").trim();
  if (!chatId) throw new Error("群 Chat ID 不能为空");
  const now = nowIso();
  db.prepare(
    `INSERT INTO feishu_groups(id, name, chat_id, webhook, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, chat_id = excluded.chat_id,
       webhook = excluded.webhook, enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(
    id,
    String(input.name || "飞书群"),
    chatId,
    String(input.webhook || ""),
    input.enabled === false ? 0 : 1,
    existing?.created_at || now,
    now
  );
  db.prepare("DELETE FROM feishu_group_roles WHERE group_id = ?").run(id);
  const roles = Array.isArray(input.roles) ? input.roles : [];
  for (const item of roles) {
    const roleUuid = typeof item === "string" ? item : item.role_uuid;
    if (!roleUuid) continue;
    db.prepare(
      `INSERT OR REPLACE INTO feishu_group_roles(group_id, role_uuid, notify_login, notify_error, notify_daily)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      id,
      roleUuid,
      item.notify_login === false || item.notifyLogin === false ? 0 : 1,
      item.notify_error === false || item.notifyError === false ? 0 : 1,
      item.notify_daily === false || item.notifyDaily === false ? 0 : 1
    );
  }
  return getGroup(db, id);
}

function deleteGroup(db, id) {
  db.prepare("DELETE FROM feishu_group_roles WHERE group_id = ?").run(id);
  return Number(db.prepare("DELETE FROM feishu_groups WHERE id = ?").run(id).changes || 0);
}

function credentials() {
  const env = messagePlatform.readEnv();
  return {
    appId: env.FEISHU_APP_ID || "",
    appSecret: env.FEISHU_APP_SECRET || "",
  };
}

async function sendToGroups(db, type, text, roleUuid = "") {
  const groups = listGroups(db).filter((group) => group.enabled);
  const targets = [];
  for (const group of groups) {
    const matched = group.roles.filter((item) => (!roleUuid || item.role_uuid === roleUuid) && item[`notify_${type}`]);
    if (matched.length) targets.push(group);
  }
  if (!targets.length) {
    createNotification(db, { type, title: `本地通知：${type}`, body: text, channels: ["toast", "tray"] });
    return { ok: true, delivered: 0, localOnly: true };
  }
  const creds = credentials();
  const results = [];
  for (const group of targets) {
    try {
      const result = await sendFeishuText(group.chat_id, text, {
        webhook: group.webhook,
        appId: creds.appId,
        appSecret: creds.appSecret,
      });
      results.push({ groupId: group.id, name: group.name, ok: true, ...result });
    } catch (error) {
      results.push({ groupId: group.id, name: group.name, ok: false, error: error.message });
    }
  }
  return { ok: results.some((item) => item.ok), delivered: results.filter((item) => item.ok).length, results };
}

async function sendReportToGroups(db, report) {
  return sendToGroups(db, "daily", report.content, report.role_uuid);
}

module.exports = { MAX_GROUPS, listGroups, getGroup, saveGroup, deleteGroup, sendToGroups, sendReportToGroups };
