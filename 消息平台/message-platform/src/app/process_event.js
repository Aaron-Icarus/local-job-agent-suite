const path = require("path");
const { appendJsonLine } = require("../core/json_file");
const { loadConfig, validateConfig, findAgent, findChannel, findConversation } = require("../core/config_loader");
const { parseFeishuEvent } = require("../channels/feishu_event_parser");
const { cleanExternalMessage } = require("../messages/message_cleaner");
const { chooseAgent } = require("../routing/agent_router");
const { resolveSession } = require("../routing/session_router");
const { SessionStore } = require("../sessions/session_store");
const { runAgent } = require("../executors/executor_factory");
const { sendFeishuText, sendFeishuReply, delivered } = require("../channels/feishu_sender");
const { buildJobGreetingPrompt } = require("../prompts/job_greeting_prompt");
const { EventStore } = require("../core/event_store");

function runtimePath(config, key) {
  return path.resolve(config.rootDir, config.runtime.state[key]);
}

function reject(reason, detail = {}) {
  return { accepted: false, reason, ...detail };
}

async function processMessage(message, options = {}) {
  const config = options.config || loadConfig(options.rootDir);
  const errors = validateConfig(config);
  if (errors.length) return reject("invalid_config", { errors });
  const sourceId = options.sourceId || `${message.source}_jobs_group`;
  const channel = findChannel(config, sourceId);
  if (!channel) return reject("channel_not_found", { sourceId });
  if (!channel.enabled && !options.forceEnabled) return reject("channel_disabled", { sourceId });
  if (channel.allowed_chat_ids?.length && !channel.allowed_chat_ids.includes(message.chat_id)) {
    return reject("chat_not_allowed", { chatId: message.chat_id });
  }
  if (channel.allowed_user_ids?.length && !channel.allowed_user_ids.includes(message.sender_id)) {
    return reject("user_not_allowed", { senderId: message.sender_id });
  }
  const conversation = findConversation(config, sourceId, message.chat_id);
  if (!conversation) return reject("conversation_not_found", { chatId: message.chat_id });
  if (!conversation.enabled && !options.forceEnabled) return reject("conversation_disabled", { conversationId: conversation.conversation_id });
  const cleaned = cleanExternalMessage(message, channel, conversation.message_cleaner);
  if (channel.mention_required && !cleaned.mentions_bot) return reject("mention_required", { cleaned });
  if (!cleaned.clean_text) return reject("empty_message_after_cleaning", { cleaned });
  const eventStore = options.eventStore || new EventStore(config.rootDir, config.runtime.state.event_store_path);
  const eventClaim = eventStore.claim(channel.channel_account_id || channel.source_id, cleaned.event_id);
  if (!eventClaim.claimed) {
    return { accepted: true, duplicate: true, event_id: cleaned.event_id, previous_status: eventClaim.record?.status || "unknown" };
  }
  const chosen = chooseAgent(cleaned, conversation);
  const agent = findAgent(config, chosen.agentId);
  if (!agent?.enabled) return reject("agent_disabled_or_missing", { agentId: chosen.agentId });
  const store = options.sessionStore || new SessionStore(config.rootDir, config.runtime.state.session_store_path);
  const sessionResult = resolveSession(cleaned, conversation, agent.agent_id, store);
  const input = { ...cleaned, command: chosen.command, session: sessionResult.session, root_dir: config.rootDir };
  if (agent.executor_config?.prompt_template_path) {
    input.agent_prompt = buildJobGreetingPrompt(input, agent, config.rootDir);
  }
  const output = await runAgent(input, agent);
  let sendResult = { skipped: true, reason: "send disabled by output policy" };
  if (conversation.output_policy?.send_to_source_chat && options.send !== false) {
    sendResult = conversation.output_policy?.reply_to_source_message
      ? await sendFeishuReply(cleaned.message_id, output.reply_text, { channel })
      : await sendFeishuText(output.reply_text, { chatId: cleaned.chat_id, channel });
  }
  const botMessageId = sendResult.message_id || "";
  store.recordTurn(sessionResult.session, {
    userMessageId: cleaned.message_id,
    botMessageId,
    summary: output.session_update || ""
  });
  appendJsonLine(runtimePath(config, "event_log_path"), {
    at: new Date().toISOString(),
    message_id: cleaned.message_id,
    chat_id: cleaned.chat_id,
    sender_id: cleaned.sender_id,
    agent_id: agent.agent_id,
    session_id: sessionResult.session.session_id,
    session_action: sessionResult.action,
    sent: delivered(sendResult),
    send_result: sendResult.skipped ? sendResult : { status: sendResult.status }
  });
  eventStore.finish(eventClaim.key, delivered(sendResult) ? "completed" : "completed_without_delivery", {
    message_id: cleaned.message_id,
    bot_message_id: botMessageId,
    session_id: sessionResult.session.session_id,
  });
  return {
    accepted: true,
    cleaned,
    agent_id: agent.agent_id,
    command: chosen.command,
    session: sessionResult,
    output,
    send_result: sendResult,
    delivered: delivered(sendResult)
  };
}

async function processFeishuBody(body, options = {}) {
  const parsed = parseFeishuEvent(body);
  if (parsed.kind === "challenge") return { accepted: true, challenge: parsed.challenge };
  return processMessage(parsed, { ...options, sourceId: options.sourceId || "feishu_jobs_group" });
}

module.exports = { processMessage, processFeishuBody };
