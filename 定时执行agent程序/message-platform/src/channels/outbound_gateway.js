const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sendFeishuText, delivered } = require("./feishu_sender");
const { readJson, writeJson } = require("../core/json_file");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(rootDir, event) {
  const filePath = path.join(rootDir, "logs", "outbound_notifications.log");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function idempotencyKey(notification) {
  if (notification.idempotency_key) return notification.idempotency_key;
  return crypto.createHash("sha256").update(JSON.stringify({
    topic: notification.topic || "general",
    target: notification.target || "default",
    text: notification.text || ""
  })).digest("hex");
}

function dispatchStatePath(rootDir) {
  return path.join(rootDir, "data", "state", "outbound_dispatches.json");
}

function missingSendConfiguration(notification) {
  const mode = String(notification.mode || process.env.FEISHU_SEND_MODE || "none").toLowerCase();
  if (mode === "app") {
    const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID"].filter((key) => !process.env[key] && !(key === "FEISHU_CHAT_ID" && process.env.FEISHU_TEST_CHAT_ID));
    return missing.length ? `发送配置不完整：缺少 ${missing.join("、")}` : "";
  }
  if (mode === "webhook") return process.env.FEISHU_WEBHOOK_URL ? "" : "发送配置不完整：缺少 FEISHU_WEBHOOK_URL";
  return "发送未启用：请配置 FEISHU_SEND_MODE=app 或 webhook";
}

function loadDispatches(rootDir) {
  const state = readJson(dispatchStatePath(rootDir), { dispatches: {} });
  state.dispatches = state.dispatches || {};
  return state;
}

function saveDispatches(rootDir, state) {
  const entries = Object.entries(state.dispatches).slice(-2000);
  state.dispatches = Object.fromEntries(entries);
  writeJson(dispatchStatePath(rootDir), state);
}

async function sendActiveNotification(notification, options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "..", "..");
  const configurationError = missingSendConfiguration(notification);
  if (configurationError) {
    const result = { delivered: false, accepted: false, configuration_error: true, attempts: 0, result: { skipped: true, reason: configurationError } };
    appendLog(rootDir, { type: "active_notification_configuration_error", topic: notification.topic || "general", result: result.result });
    return { ...result, idempotency_key: idempotencyKey(notification) };
  }
  const maxAttempts = Math.max(1, Number(notification.max_attempts || process.env.OUTBOUND_MAX_ATTEMPTS || 3));
  const key = idempotencyKey(notification);
  const dispatches = loadDispatches(rootDir);
  const existing = dispatches.dispatches[key];
  if (existing?.status === "sent") return { delivered: true, accepted: true, duplicate: true, idempotency_key: key, attempts: existing.attempts, result: existing.result };
  if (existing?.status === "delivery_uncertain") return { delivered: false, accepted: false, delivery_uncertain: true, idempotency_key: key, attempts: existing.attempts, result: existing.result };
  let lastResult = { skipped: true, reason: "not attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastResult = await sendFeishuText(String(notification.text || ""), {
        chatId: notification.chat_id,
        mode: notification.mode || process.env.FEISHU_SEND_MODE || "app"
      });
    } catch (error) {
      lastResult = { error: error.message };
      dispatches.dispatches[key] = { status: "delivery_uncertain", attempts: attempt, result: lastResult, updated_at: new Date().toISOString() };
      saveDispatches(rootDir, dispatches);
      appendLog(rootDir, { type: "active_notification", topic: notification.topic || "general", idempotency_key: key, attempt, delivered: false, delivery_uncertain: true, result: lastResult });
      return { delivered: false, accepted: false, delivery_uncertain: true, idempotency_key: key, attempts: attempt, result: lastResult };
    }
    const success = delivered(lastResult);
    appendLog(rootDir, {
      type: "active_notification",
      topic: notification.topic || "general",
      idempotency_key: key,
      attempt,
      delivered: success,
      result: lastResult.skipped ? lastResult : { status: lastResult.status, body: lastResult.body }
    });
    if (success) {
      dispatches.dispatches[key] = { status: "sent", attempts: attempt, result: lastResult, updated_at: new Date().toISOString() };
      saveDispatches(rootDir, dispatches);
      return { delivered: true, accepted: true, idempotency_key: key, attempts: attempt, result: lastResult };
    }
    if (attempt < maxAttempts) await sleep(Math.min(1000 * attempt, 3000));
  }
  dispatches.dispatches[key] = { status: "failed_exhausted", attempts: maxAttempts, result: lastResult, updated_at: new Date().toISOString() };
  saveDispatches(rootDir, dispatches);
  return { delivered: false, accepted: false, idempotency_key: key, attempts: maxAttempts, result: lastResult };
}

module.exports = { sendActiveNotification, idempotencyKey };
