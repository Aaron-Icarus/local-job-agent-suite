const crypto = require("crypto");
const { nowIso } = require("./jobs_repo");
const { sendFeishuText } = require("./feishu_sender");
const { createNotification } = require("./notifier");
const messagePlatform = require("./message_platform_service");

const MAX_GROUPS = 10;

function ensureHealthColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(feishu_groups)").all().map((row) => row.name));
  if (!columns.has("last_test_at")) db.prepare("ALTER TABLE feishu_groups ADD COLUMN last_test_at TEXT").run();
  if (!columns.has("last_test_ok")) db.prepare("ALTER TABLE feishu_groups ADD COLUMN last_test_ok INTEGER").run();
  if (!columns.has("last_test_error")) db.prepare("ALTER TABLE feishu_groups ADD COLUMN last_test_error TEXT NOT NULL DEFAULT ''").run();
}

function mapGroup(db, row) {
  const roles = db.prepare(
    "SELECT role_uuid, notify_login, notify_error, notify_daily FROM feishu_group_roles WHERE group_id = ?"
  ).all(row.id).map((item) => ({
    role_uuid: item.role_uuid,
    notify_login: Boolean(item.notify_login),
    notify_error: Boolean(item.notify_error),
    notify_daily: Boolean(item.notify_daily),
  }));
  const status = !row.enabled ? "disabled" : row.last_test_ok === 1 ? "normal" : row.last_test_ok === 0 ? "error" : "untested";
  return {
    ...row,
    enabled: Boolean(row.enabled),
    is_default: Boolean(row.is_default),
    status,
    roles,
  };
}

function listGroups(db) {
  ensureHealthColumns(db);
  return db.prepare(
    `SELECT * FROM feishu_groups
     ORDER BY CASE
       WHEN enabled = 0 THEN 0
       WHEN last_test_ok = 0 THEN 1
       WHEN last_test_ok IS NULL THEN 2
       ELSE 3 END, created_at ASC`
  ).all().map((row) => mapGroup(db, row));
}

function getGroup(db, id) {
  ensureHealthColumns(db);
  const row = db.prepare("SELECT * FROM feishu_groups WHERE id = ?").get(id);
  return row ? mapGroup(db, row) : null;
}

function saveGroup(db, input = {}) {
  ensureHealthColumns(db);
  const id = String(input.id || crypto.randomUUID());
  const existing = db.prepare("SELECT * FROM feishu_groups WHERE id = ?").get(id);
  if (!existing && listGroups(db).length >= MAX_GROUPS) throw new Error(`最多只能接入 ${MAX_GROUPS} 个飞书群`);
  const chatId = String(input.chatId || input.chat_id || existing?.chat_id || "").trim();
  if (!chatId) throw new Error("群 Chat ID 不能为空");
  const now = nowIso();
  if (input.isDefault) db.prepare("UPDATE feishu_groups SET is_default = 0").run();
  db.prepare(
    `INSERT INTO feishu_groups(id, name, chat_id, webhook, enabled, is_default, reply_role_uuid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, chat_id = excluded.chat_id,
       webhook = excluded.webhook, enabled = excluded.enabled, is_default = excluded.is_default,
       reply_role_uuid = excluded.reply_role_uuid, updated_at = excluded.updated_at`
  ).run(
    id,
    String(input.name || "飞书群"),
    chatId,
    String(input.webhook || ""),
    input.enabled === false ? 0 : 1,
    input.isDefault ? 1 : (existing?.is_default || 0),
    String(input.replyRoleUuid || input.reply_role_uuid || existing?.reply_role_uuid || ""),
    existing?.created_at || now,
    now
  );
  if (Array.isArray(input.roles)) {
    db.prepare("DELETE FROM feishu_group_roles WHERE group_id = ?").run(id);
    const roles = input.roles;
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
    if (!input.replyRoleUuid && !input.reply_role_uuid && !existing?.reply_role_uuid && roles.length) {
      db.prepare("UPDATE feishu_groups SET reply_role_uuid = ? WHERE id = ?").run(
        typeof roles[0] === "string" ? roles[0] : roles[0].role_uuid,
        id
      );
    }
  }
  return getGroup(db, id);
}

function deleteGroup(db, id) {
  db.prepare("DELETE FROM feishu_group_roles WHERE group_id = ?").run(id);
  return Number(db.prepare("DELETE FROM feishu_groups WHERE id = ?").run(id).changes || 0);
}

function applyDefaultGroup(db, roleUuid) {
  const group = db.prepare("SELECT * FROM feishu_groups WHERE is_default = 1 AND enabled = 1 LIMIT 1").get();
  if (!group) return null;
  db.prepare(
    `INSERT OR REPLACE INTO feishu_group_roles(group_id, role_uuid, notify_login, notify_error, notify_daily)
     VALUES (?, ?, 1, 1, 1)`
  ).run(group.id, roleUuid);
  return group;
}

function setDefaultGroup(db, groupId) {
  db.prepare("UPDATE feishu_groups SET is_default = 0").run();
  db.prepare("UPDATE feishu_groups SET is_default = 1, updated_at = ? WHERE id = ?").run(nowIso(), groupId);
  return getGroup(db, groupId);
}

function routeRole(db, roleUuid, groupId, flags = {}) {
  db.prepare("DELETE FROM feishu_group_roles WHERE role_uuid = ?").run(roleUuid);
  if (!groupId) return null;
  const group = getGroup(db, groupId);
  if (!group) throw new Error("群不存在");
  db.prepare(
    `INSERT INTO feishu_group_roles(group_id, role_uuid, notify_login, notify_error, notify_daily)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    groupId,
    roleUuid,
    flags.notifyLogin === false ? 0 : 1,
    flags.notifyError === false ? 0 : 1,
    flags.notifyDaily === false ? 0 : 1
  );
  return group;
}

function routing(db) {
  const roles = db.prepare(
    "SELECT role_uuid, role_number, nickname, status FROM roles WHERE deleted_at IS NULL ORDER BY role_number"
  ).all();
  const groups = listGroups(db);
  const defaultGroup = groups.find((group) => group.is_default) || null;
  return {
    defaultGroupId: defaultGroup?.id || "",
    roles: roles.map((role) => {
      const group = groups.find((item) => item.roles.some((r) => r.role_uuid === role.role_uuid));
      const mapping = group?.roles.find((r) => r.role_uuid === role.role_uuid);
      const stage = (flag) => {
        const owner = groups.find((item) => item.roles.some((r) => r.role_uuid === role.role_uuid && r[flag]));
        return owner ? { groupId: owner.id, groupName: owner.name } : { groupId: "", groupName: "" };
      };
      return {
        ...role,
        groupId: group?.id || "",
        groupName: group?.name || "",
        notifyLogin: mapping?.notify_login ?? true,
        notifyError: mapping?.notify_error ?? true,
        notifyDaily: mapping?.notify_daily ?? true,
        stages: {
          login: stage("notify_login"),
          error: stage("notify_error"),
          daily: stage("notify_daily"),
        },
      };
    }),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      chatId: group.chat_id,
      status: group.status,
      enabled: group.enabled,
      isDefault: group.is_default,
      lastTestAt: group.last_test_at || "",
      lastTestError: group.last_test_error || "",
    })),
  };
}

function setRoleStageGroup(db, roleUuid, stage, groupId) {
  ensureHealthColumns(db);
  const column = { login: "notify_login", error: "notify_error", daily: "notify_daily" }[stage];
  if (!column) throw new Error("未知通知环节");
  const rows = db.prepare("SELECT * FROM feishu_group_roles WHERE role_uuid = ?").all(roleUuid);
  for (const row of rows) {
    db.prepare(`UPDATE feishu_group_roles SET ${column} = 0 WHERE group_id = ? AND role_uuid = ?`).run(row.group_id, roleUuid);
  }
  if (groupId) {
    const group = getGroup(db, groupId);
    if (!group) throw new Error("群不存在");
    const existing = rows.find((row) => row.group_id === groupId);
    const flags = {
      notify_login: existing?.notify_login || 0,
      notify_error: existing?.notify_error || 0,
      notify_daily: existing?.notify_daily || 0,
    };
    flags[column] = 1;
    db.prepare(
      `INSERT OR REPLACE INTO feishu_group_roles(group_id, role_uuid, notify_login, notify_error, notify_daily)
       VALUES (?, ?, ?, ?, ?)`
    ).run(groupId, roleUuid, flags.notify_login, flags.notify_error, flags.notify_daily);
  }
  db.prepare(
    "DELETE FROM feishu_group_roles WHERE role_uuid = ? AND notify_login = 0 AND notify_error = 0 AND notify_daily = 0"
  ).run(roleUuid);
  return routing(db);
}

function credentials() {
  const env = messagePlatform.readEnv();
  return {
    appId: env.FEISHU_APP_ID || "",
    appSecret: env.FEISHU_APP_SECRET || "",
  };
}

async function testGroup(db, id) {
  ensureHealthColumns(db);
  const group = getGroup(db, id);
  if (!group) throw new Error("群不存在");
  const creds = credentials();
  try {
    const result = await sendFeishuText(group.chat_id, `【群连通测试】${new Date().toLocaleString("zh-CN", { hour12: false })} 配置已保存，这条消息用于确认群通道。`, {
      webhook: group.webhook,
      appId: creds.appId,
      appSecret: creds.appSecret,
    });
    db.prepare("UPDATE feishu_groups SET last_test_at = ?, last_test_ok = 1, last_test_error = '', updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), id);
    return result;
  } catch (error) {
    db.prepare("UPDATE feishu_groups SET last_test_at = ?, last_test_ok = 0, last_test_error = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), String(error.message || error).slice(0, 1000), nowIso(), id);
    throw error;
  }
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

module.exports = { MAX_GROUPS, listGroups, getGroup, saveGroup, deleteGroup, applyDefaultGroup, setDefaultGroup, routeRole, routing, setRoleStageGroup, testGroup, sendToGroups, sendReportToGroups };
