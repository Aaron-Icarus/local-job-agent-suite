const { runPingAgent } = require("./ping_executor");
const { runJobGreetingAgent } = require("./job_greeting_executor");
const { runLocalChatAgent } = require("./local_chat_executor");

async function runAgent(input, agentConfig) {
  if (!agentConfig?.enabled) throw new Error(`Agent is disabled or missing: ${agentConfig?.agent_id || "unknown"}`);
  if (agentConfig.executor_type === "ping") return runPingAgent(input, agentConfig);
  if (agentConfig.executor_type === "job_greeting") return runJobGreetingAgent(input, agentConfig);
  if (agentConfig.executor_type === "local_chat") return runLocalChatAgent(input, agentConfig);
  throw new Error(`Unsupported executor_type: ${agentConfig.executor_type}`);
}

module.exports = { runAgent };
