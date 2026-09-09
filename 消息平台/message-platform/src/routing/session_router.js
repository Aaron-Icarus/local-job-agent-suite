const { includesAny } = require("./agent_router");

function extractSessionId(text) {
  const match = String(text || "").match(/#?([a-zA-Z0-9_-]+-\d{8}-[a-z0-9]+)/);
  return match ? match[1] : "";
}

function resolveSession(cleaned, conversation, agentId, store) {
  const policy = conversation.session_policy || {};
  const ttl = Number(policy.ttl_minutes || 60);
  const explicitId = extractSessionId(cleaned.clean_text);
  if (explicitId) {
    const existing = store.findById(explicitId);
    if (existing) return { session: existing, action: "continue", reason: "explicit_session_id" };
  }
  if (cleaned.parent_message_id) {
    const parent = store.findByMessage(cleaned.parent_message_id);
    if (parent) return { session: parent, action: "continue", reason: "reply_parent_message" };
  }
  if (includesAny(cleaned.clean_text, policy.new_task_keywords || [])) {
    return {
      session: store.createSession({ chatId: cleaned.chat_id, agentId, rootMessageId: cleaned.message_id, ttlMinutes: ttl }),
      action: "new",
      reason: "new_task_keyword"
    };
  }
  if (includesAny(cleaned.clean_text, policy.continue_keywords || [])) {
    const open = store.openSessions(cleaned.chat_id, agentId, ttl);
    if (open.length === 1) return { session: open[0], action: "continue", reason: "single_recent_open_session" };
  }
  return {
    session: store.createSession({ chatId: cleaned.chat_id, agentId, rootMessageId: cleaned.message_id, ttlMinutes: ttl }),
    action: "new",
    reason: "default_new_session"
  };
}

module.exports = { resolveSession, extractSessionId };
