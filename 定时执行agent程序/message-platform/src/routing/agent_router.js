function includesAny(text, patterns = []) {
  const lowered = String(text || "").toLowerCase();
  return patterns.some((pattern) => lowered.includes(String(pattern).toLowerCase()));
}

function chooseAgent(cleaned, conversation) {
  for (const command of conversation.routing_policy?.commands || []) {
    if (includesAny(cleaned.clean_text, command.patterns)) {
      return { agentId: command.agent_id, command: command.name };
    }
  }
  return { agentId: conversation.default_agent_id, command: "default" };
}

module.exports = { chooseAgent, includesAny };
