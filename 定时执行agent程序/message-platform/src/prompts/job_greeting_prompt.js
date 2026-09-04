const fs = require("fs");
const path = require("path");

function compactJobRecord(record) {
  if (!record) return "未找到岗位编号对应的档案。请要求用户补充岗位信息或重新指定编号。";
  return JSON.stringify({
    display_id: record.display_id,
    platform: record.platform,
    company: record.company,
    job_title: record.job_title,
    salary: record.salary,
    location: record.location,
    job_description: record.job_description,
    job_url: record.job_url || "未提供"
  });
}

function buildJobGreetingPrompt(input, agentConfig, rootDir) {
  const promptPath = path.resolve(rootDir, agentConfig.executor_config.prompt_template_path);
  const template = fs.readFileSync(promptPath, "utf8");
  // The recruitment Agent resolves its own job index; the message platform
  // carries only a controlled request and does not read business data files.
  const job = input.job_record || null;
  const sessionContext = input.session?.context_summary || "这是本轮新任务。";
  return template
    .replace("{{user_request}}", input.clean_text || "未提供")
    .replace("{{job_record}}", compactJobRecord(job))
    .replace("{{session_context}}", sessionContext);
}

module.exports = { buildJobGreetingPrompt, compactJobRecord };
