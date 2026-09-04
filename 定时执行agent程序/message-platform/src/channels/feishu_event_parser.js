function parseContent(content) {
  if (!content) return "";
  if (typeof content === "object") return content.text || "";
  try {
    const parsed = JSON.parse(content);
    return parsed.text || "";
  } catch {
    return String(content);
  }
}

function parseFeishuEvent(body) {
  if (body.challenge) {
    return { kind: "challenge", challenge: body.challenge };
  }
  const header = body.header || {};
  const event = body.event || {};
  const message = event.message || {};
  const chatId = message.chat_id || event.chat_id || "";
  return {
    kind: "message",
    source: "feishu",
    event_id: header.event_id || "",
    event_type: header.event_type || "",
    message_id: message.message_id || "",
    parent_message_id: message.parent_id || message.root_id || "",
    chat_id: chatId,
    chat_type: message.chat_type || "",
    sender_id: event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || "",
    text: parseContent(message.content),
    mentions: message.mentions || [],
    raw: body
  };
}

module.exports = { parseFeishuEvent, parseContent };
