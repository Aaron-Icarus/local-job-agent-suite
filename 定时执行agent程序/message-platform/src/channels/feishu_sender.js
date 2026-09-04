const crypto = require("crypto");

function feishuWebhookSign(secret, timestamp) {
  return crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

function withMessageId(result) {
  if (!result?.body) return result;
  try {
    const payload = JSON.parse(result.body);
    return { ...result, message_id: payload?.data?.message_id || payload?.data?.message?.message_id || "" };
  } catch {
    return result;
  }
}

function credentials(options = {}) {
  const refs = options.channel?.credential_env || {};
  return {
    appId: options.appId || process.env[refs.app_id || "FEISHU_APP_ID"],
    appSecret: options.appSecret || process.env[refs.app_secret || "FEISHU_APP_SECRET"],
    chatId: options.chatId || process.env[refs.chat_id || "FEISHU_CHAT_ID"] || process.env.FEISHU_TEST_CHAT_ID,
  };
}

async function sendFeishuWebhook(text, options = {}) {
  const url = options.webhookUrl || process.env.FEISHU_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: "FEISHU_WEBHOOK_URL not set" };
  const payload = { msg_type: "text", content: { text: text.slice(0, 18000) } };
  const secret = options.webhookSecret || process.env.FEISHU_WEBHOOK_SECRET;
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = feishuWebhookSign(secret, timestamp);
  }
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return withMessageId({ status: resp.status, body: await resp.text() });
}

async function tenantAccessToken(appId, appSecret) {
  const tokenResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const tokenPayload = await tokenResp.json();
  if (!tokenResp.ok || !tokenPayload.tenant_access_token) {
    return { accessToken: "", result: { status: tokenResp.status, error: tokenPayload.msg || "failed to get tenant_access_token" } };
  }
  return { accessToken: tokenPayload.tenant_access_token };
}

async function sendFeishuApp(text, options = {}) {
  const { appId, appSecret, chatId } = credentials(options);
  if (!appId || !appSecret || !chatId) {
    return { skipped: true, reason: "FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_ID not set" };
  }
  const token = await tenantAccessToken(appId, appSecret);
  if (!token.accessToken) return token.result;
  const msgResp = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.accessToken}`
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: text.slice(0, 18000) })
    })
  });
  return withMessageId({ status: msgResp.status, body: await msgResp.text() });
}

async function sendFeishuReply(messageId, text, options = {}) {
  if (!messageId) return { skipped: true, reason: "message_id is required for reply" };
  const { appId, appSecret } = credentials(options);
  if (!appId || !appSecret) return { skipped: true, reason: "FEISHU_APP_ID/FEISHU_APP_SECRET not set" };
  const token = await tenantAccessToken(appId, appSecret);
  if (!token.accessToken) return token.result;
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.accessToken}`
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text: String(text || "").slice(0, 18000) })
    })
  });
  return withMessageId({ status: response.status, body: await response.text() });
}

async function sendFeishuText(text, options = {}) {
  const mode = (options.mode || process.env.FEISHU_SEND_MODE || "none").toLowerCase();
  if (mode === "app") return sendFeishuApp(text, options);
  if (mode === "webhook") return sendFeishuWebhook(text, options);
  return { skipped: true, reason: "FEISHU_SEND_MODE is none" };
}

function delivered(result) {
  if (!result || result.skipped) return false;
  if (result.body) {
    try {
      const payload = JSON.parse(result.body);
      if (typeof payload.code === "number") return payload.code === 0;
    } catch {
      // Non-JSON 2xx responses are accepted below.
    }
  }
  return typeof result.status === "number" && result.status >= 200 && result.status < 300;
}

module.exports = { sendFeishuText, sendFeishuReply, delivered };
