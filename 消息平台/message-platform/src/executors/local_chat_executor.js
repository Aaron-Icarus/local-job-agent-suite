async function localChatRequest(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json.error || `本地对话 HTTP ${response.status}`);
  return json;
}

async function runLocalChatAgent(input, agentConfig) {
  const baseUrl = process.env.LOCAL_CHAT_BASE_URL || agentConfig.executor_config?.base_url || "http://127.0.0.1:4780";
  let roleUuid = agentConfig.executor_config?.role_uuid || "";
  if (!roleUuid) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/feishu-groups`, { signal: AbortSignal.timeout(5000) });
      const json = await response.json();
      const group = (json.groups || []).find((item) => item.chat_id === input.chat_id);
      roleUuid = group?.reply_role_uuid || group?.roles?.[0]?.role_uuid || "";
    } catch {
      // 没有群角色映射时继续
    }
  }
  if (!roleUuid) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/roles`, { signal: AbortSignal.timeout(5000) });
      const json = await response.json();
      roleUuid = (json.roles || []).find((item) => item.status === "running")?.role_uuid || "";
    } catch {
      // 没有本地角色时仍允许普通对话
    }
  }
  const externalKey = `feishu:${input.chat_id || "unknown"}`;
  const created = await localChatRequest(baseUrl, "/api/chat/sessions", {
    title: `飞书 ${input.chat_id || ""}`.trim(),
    externalKey,
    roleUuid,
  });
  const sessionId = created.session?.id;
  if (!sessionId) throw new Error("本地对话未返回 session");
  const result = await localChatRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    text: input.clean_text || "",
    roleUuid,
  });
  const messages = result.session?.messages || [];
  const assistant = [...messages].reverse().find((item) => item.role === "assistant");
  return {
    reply_text: assistant?.content || "本地对话没有返回内容。",
    session_update: `飞书 ${input.chat_id || ""} 对话已转发到本地对话（${sessionId}）`,
    local_chat_session_id: sessionId,
    local_chat_result: result.reply || {},
  };
}

module.exports = { runLocalChatAgent };
