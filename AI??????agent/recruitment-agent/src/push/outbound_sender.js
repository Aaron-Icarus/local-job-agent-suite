const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..", "..");
const defaultGatewayCli = path.resolve(rootDir, "..", "..", "定时执行agent程序", "message-platform", "src", "cli", "send_notification.js");

function appendLog(event) {
  const filePath = path.join(rootDir, "logs", "outbound_delivery.log");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function parseLastJson(text) {
  return String(text || "").split(/\r?\n/).reverse().map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(Boolean) || null;
}

async function localSend(text) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const chatId = process.env.FEISHU_CHAT_ID || process.env.FEISHU_TEST_CHAT_ID;
  if (!appId || !appSecret || !chatId) return { skipped: true, reason: "FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_ID not set" };
  const tokenResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.tenant_access_token) return { status: tokenResponse.status, body: JSON.stringify(token) };
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token.tenant_access_token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: String(text).slice(0, 18000) }) })
  });
  return { status: response.status, body: await response.text() };
}

function isDelivered(result) {
  if (!result || result.skipped) return false;
  if (result.delivered === true) return true;
  try { return JSON.parse(result.body || "{}").code === 0; } catch { return result.status >= 200 && result.status < 300; }
}

async function sendRecruitmentNotification(text, options = {}) {
  const idempotencyKey = options.idempotency_key || crypto.createHash("sha256").update(String(text)).digest("hex");
  const gatewayCli = process.env.MESSAGE_GATEWAY_CLI || defaultGatewayCli;
  if (fs.existsSync(gatewayCli)) {
    const notification = { text, topic: options.topic || "recruitment_report", idempotency_key: idempotencyKey, max_attempts: 3 };
    const gateway = spawnSync(process.execPath, [gatewayCli], { input: JSON.stringify(notification), encoding: "utf8", env: process.env, timeout: 30000 });
    const result = parseLastJson(gateway.stdout) || parseLastJson(gateway.stderr);
    if (result) {
      appendLog({ route: "message_platform", idempotency_key: idempotencyKey, delivered: result.delivered === true, result });
      // A reachable gateway has already made all permitted attempts. Do not send again locally.
      return result.delivered ? { status: 200, body: JSON.stringify({ code: 0, via: "message_platform" }), gateway: result } : { status: 502, body: JSON.stringify({ code: -1, via: "message_platform", result }), gateway: result };
    }
    appendLog({ route: "message_platform", idempotency_key: idempotencyKey, delivered: false, unavailable: true, error: gateway.error?.message || gateway.stderr.slice(-500) });
  } else {
    appendLog({ route: "message_platform", idempotency_key: idempotencyKey, delivered: false, unavailable: true, error: "gateway CLI missing" });
  }
  const fallback = await localSend(text);
  appendLog({ route: "agent_local_fallback", idempotency_key: idempotencyKey, delivered: isDelivered(fallback), result: fallback.skipped ? fallback : { status: fallback.status, body: fallback.body } });
  return fallback;
}

module.exports = { sendRecruitmentNotification, isDelivered };
