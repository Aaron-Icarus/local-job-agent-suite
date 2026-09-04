const path = require("path");
const { extractDisplayId } = require("../context/job_context_resolver");

function loadRecruitmentAgent(agentConfig, rootDir) {
  const configured = agentConfig.executor_config?.recruitment_agent_module;
  if (!configured) throw new Error("job_greeting_agent requires executor_config.recruitment_agent_module");
  const modulePath = path.resolve(rootDir, configured);
  // The recruitment agent owns its index, candidate profile and AI fallback policy.
  // This platform only dispatches a request that has already been routed to this Agent.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const module = require(modulePath);
  if (typeof module.createGreetingResponse !== "function") throw new Error(`Recruitment agent is invalid: ${modulePath}`);
  return module;
}

async function runJobGreetingAgent(input, agentConfig) {
  const rootDir = input.root_dir || path.resolve(__dirname, "..", "..");
  const recruitmentAgent = loadRecruitmentAgent(agentConfig, rootDir);
  const maxLength = Number(agentConfig.executor_config?.max_greeting_chars || 160);
  const displayId = extractDisplayId(input.clean_text);
  const request = input.job_record
    ? { job: input.job_record, max_length: maxLength }
    : displayId
      ? { display_id: displayId, max_length: maxLength }
      : { job_text: input.clean_text, max_length: maxLength };
  const result = await recruitmentAgent.createGreetingResponse(request);
  const title = `${result.display_id ? `${result.display_id} ` : ""}【${result.platform || "岗位信息"}】${result.company || "未知公司"} - ${result.job_title || "未知岗位"}`;
  return {
    reply_text: `${title}\n打招呼：${result.greeting_message}`,
    session_update: `岗位话术已由招聘信息智能体生成（${result.greeting_strategy}）：${result.greeting_message}`,
    provider: result.greeting_strategy,
    recruitment_result: result
  };
}

module.exports = { runJobGreetingAgent };
