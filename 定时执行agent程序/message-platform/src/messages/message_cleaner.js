function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotedText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(>|回复|引用|原消息[:：])/.test(line))
    .join("\n");
}

function hasBotMention(message, channel) {
  const botIds = new Set([...(channel.bot_ids || []), channel.bot_open_id].filter(Boolean));
  const aliases = channel.bot_aliases || [];
  for (const mention of message.mentions || []) {
    const mentionId = mention.id?.open_id || mention.id?.user_id || mention.open_id || mention.user_id || mention.tenant_key || "";
    if (botIds.has(mentionId)) return true;
    if (mention.name && aliases.includes(mention.name)) return true;
    // A Feishu app mention is a safe compatibility fallback when an explicit
    // bot identifier has not yet been configured; user mentions never trigger.
    if (mention.mentioned_type === "app") return true;
  }
  return aliases.some((alias) => new RegExp(`(^|\\s)@?${escapeRegExp(alias)}([\\s,:：，,]|$)`).test(message.text || ""));
}

function cleanExternalMessage(message, channel, cleanerConfig = {}) {
  let text = String(message.text || "");
  if (cleanerConfig.strip_quoted_text !== false) text = stripQuotedText(text);
  if (cleanerConfig.strip_mentions !== false) {
    for (const mention of message.mentions || []) {
      if (mention.key) text = text.replaceAll(mention.key, " ");
    }
    text = text.replace(/@_user_\d+/g, " ");
  }
  for (const alias of channel.bot_aliases || []) {
    text = text.replace(new RegExp(`@?${escapeRegExp(alias)}`, "g"), " ");
  }
  for (const prefix of channel.command_prefixes || []) {
    text = text.replace(new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*[:：,，-]*\\s*`, "i"), "");
  }
  text = text.replace(/\s+/g, " ").trim();
  return {
    source: message.source,
    event_id: message.event_id || "",
    chat_id: message.chat_id,
    sender_id: message.sender_id,
    message_id: message.message_id,
    parent_message_id: message.parent_message_id,
    raw_text: message.text || "",
    clean_text: text,
    mentions_bot: hasBotMention(message, channel),
    attachments: message.attachments || []
  };
}

module.exports = { cleanExternalMessage, hasBotMention };
