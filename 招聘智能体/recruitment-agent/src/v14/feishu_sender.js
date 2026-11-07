async function feishuTenantToken(appId, appSecret) {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json();
  if (!response.ok || !json.tenant_access_token) {
    throw new Error(json.msg || `飞书 tenant token 失败：HTTP ${response.status}`);
  }
  return json.tenant_access_token;
}

async function sendFeishuText(chatId, text, credentials = {}) {
  if (credentials.webhook) {
    const response = await fetch(credentials.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`飞书 webhook HTTP ${response.status}`);
    return { ok: true, mode: "webhook" };
  }
  if (!credentials.appId || !credentials.appSecret) throw new Error("未配置飞书 App ID/App Secret 或 webhook");
  const token = await feishuTenantToken(credentials.appId, credentials.appSecret);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json();
  if (!response.ok || json.code !== 0) throw new Error(json.msg || `飞书发送失败：HTTP ${response.status}`);
  return { ok: true, mode: "app", messageId: json.data?.message_id || "" };
}

module.exports = { feishuTenantToken, sendFeishuText };
