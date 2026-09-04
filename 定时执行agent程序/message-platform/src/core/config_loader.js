const fs = require("fs");
const path = require("path");
const { loadEnvFiles } = require("./load_env");

function readConfig(rootDir, name) {
  const filePath = path.join(rootDir, name);
  if (!fs.existsSync(filePath)) throw new Error(`Missing config file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadConfig(rootDir = path.resolve(__dirname, "..", "..")) {
  const runtime = readConfig(rootDir, "runtime.config.json");
  const envLoadResults = loadEnvFiles(rootDir, runtime.env_files || []);
  const channels = readConfig(rootDir, "channels.config.json").channels || [];
  const agents = readConfig(rootDir, "agents.config.json").agents || [];
  const conversations = readConfig(rootDir, "routes.config.json").conversations || [];
  return { rootDir, runtime, channels, agents, conversations, envLoadResults };
}

function findAgent(config, agentId) {
  return config.agents.find((agent) => agent.agent_id === agentId);
}

function findChannel(config, sourceId) {
  return config.channels.find((channel) => channel.source_id === sourceId);
}

function findConversation(config, sourceId, chatId) {
  return config.conversations.find((item) => item.source_id === sourceId && item.chat_id === chatId);
}

function validateConfig(config) {
  const errors = [];
  const agentIds = new Set(config.agents.map((agent) => agent.agent_id));
  const sourceIds = new Set(config.channels.map((channel) => channel.source_id));
  for (const conversation of config.conversations) {
    if (!sourceIds.has(conversation.source_id)) {
      errors.push(`Conversation ${conversation.conversation_id} references missing source ${conversation.source_id}`);
    }
    if (conversation.default_agent_id && !agentIds.has(conversation.default_agent_id)) {
      errors.push(`Conversation ${conversation.conversation_id} references missing agent ${conversation.default_agent_id}`);
    }
    for (const command of conversation.routing_policy?.commands || []) {
      if (!agentIds.has(command.agent_id)) {
        errors.push(`Conversation ${conversation.conversation_id} command ${command.name} references missing agent ${command.agent_id}`);
      }
    }
    if (conversation.enabled) {
      const channel = config.channels.find((item) => item.source_id === conversation.source_id);
      const agent = config.agents.find((item) => item.agent_id === conversation.default_agent_id);
      if (!channel?.enabled) errors.push(`Conversation ${conversation.conversation_id} is enabled but channel is disabled`);
      if (!agent?.enabled) errors.push(`Conversation ${conversation.conversation_id} is enabled but default agent is disabled`);
    }
  }
  return errors;
}

module.exports = { loadConfig, validateConfig, findAgent, findChannel, findConversation };
