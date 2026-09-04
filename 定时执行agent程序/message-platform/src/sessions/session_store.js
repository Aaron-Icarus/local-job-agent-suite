const path = require("path");
const { readJson, writeJson } = require("../core/json_file");

function nowIso() {
  return new Date().toISOString();
}

function makeSessionId(prefix = "task") {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${suffix}`;
}

class SessionStore {
  constructor(rootDir, storePath) {
    this.rootDir = rootDir;
    this.storePath = path.resolve(rootDir, storePath);
    this.state = readJson(this.storePath, { sessions: [], message_session_index: {} });
  }

  save() {
    writeJson(this.storePath, this.state);
  }

  findById(sessionId) {
    return this.state.sessions.find((item) => item.session_id === sessionId);
  }

  findByMessage(messageId) {
    const sessionId = this.state.message_session_index[messageId];
    return sessionId ? this.findById(sessionId) : null;
  }

  openSessions(chatId, agentId, ttlMinutes) {
    const cutoff = Date.now() - ttlMinutes * 60 * 1000;
    return this.state.sessions.filter((item) => (
      item.chat_id === chatId &&
      item.agent_id === agentId &&
      ["open", "waiting_user"].includes(item.status) &&
      new Date(item.updated_at).getTime() >= cutoff
    ));
  }

  createSession({ chatId, agentId, rootMessageId, ttlMinutes, contextSummary = "" }) {
    const session = {
      session_id: makeSessionId(agentId.replace(/_agent$/, "")),
      chat_id: chatId,
      agent_id: agentId,
      root_message_id: rootMessageId,
      last_user_message_id: rootMessageId,
      last_bot_message_id: "",
      status: "open",
      ttl_minutes: ttlMinutes,
      turn_count: 0,
      context_summary: contextSummary,
      context_refs: {},
      created_at: nowIso(),
      updated_at: nowIso()
    };
    this.state.sessions.push(session);
    this.state.message_session_index[rootMessageId] = session.session_id;
    this.save();
    return session;
  }

  recordTurn(session, { userMessageId, botMessageId = "", summary = "" }) {
    session.turn_count += 1;
    session.last_user_message_id = userMessageId || session.last_user_message_id;
    if (botMessageId) session.last_bot_message_id = botMessageId;
    if (summary) {
      session.context_summary = [session.context_summary, summary].filter(Boolean).join("\n").slice(-4000);
    }
    session.updated_at = nowIso();
    if (userMessageId) this.state.message_session_index[userMessageId] = session.session_id;
    if (botMessageId) this.state.message_session_index[botMessageId] = session.session_id;
    this.save();
  }
}

module.exports = { SessionStore };
