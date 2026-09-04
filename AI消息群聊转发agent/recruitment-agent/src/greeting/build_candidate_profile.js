const fs = require("fs");
const path = require("path");
const { loadEnv, envNumber } = require("../core/load_env");
const { runAiTask } = require("../core/ai_router");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const profileDir = path.join(rootDir, "config", "candidate_profiles");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function usage() {
  console.error("Usage: node src/greeting/build_candidate_profile.js --input candidate_source.txt --id candidate_id");
}

async function buildProfile(sourceText, candidateId) {
  const ai = await runAiTask({
    purpose: "profile",
    options: { max_output_tokens: envNumber("PROFILE_AI_MAX_OUTPUT_TOKENS", 2200) },
    instructions: "将求职者提供的简历、补充说明和预期岗位整理成候选人画像 Markdown。只输出 Markdown，不要解释。必须按以下结构：# 当前推荐人画像；## 求职目标；## 最近 3 年优先经历；## 最近 5 年可用经历；## 可验证优势；## 打招呼生成原则。保留可验证事实；突出最近三年。不要杜撰，不要保留手机号、邮箱、身份证等敏感信息。",
    input: { candidate_source: sourceText.slice(0, 30000) },
  });
  if (!ai.ok) throw new Error(`AI 调用不可用，无法构建候选人画像：${ai.reason}`);
  return { markdown: ai.text.trim(), model: ai.model, provider: ai.provider, candidateId };
}

async function main() {
  const inputPath = argValue("--input");
  const candidateId = argValue("--id");
  if (!inputPath || !candidateId) {
    usage();
    process.exitCode = 1;
    return;
  }
  const sourceText = fs.readFileSync(path.resolve(process.cwd(), inputPath), "utf8");
  const result = await buildProfile(sourceText, candidateId);
  fs.mkdirSync(profileDir, { recursive: true });
  const targetPath = path.join(profileDir, `${candidateId}.md`);
  fs.writeFileSync(targetPath, `${result.markdown}\n`, "utf8");
  fs.writeFileSync(path.join(profileDir, "current.json"), JSON.stringify({
    current_candidate_id: candidateId,
    profile_file: `${candidateId}.md`,
    profile_version: 1,
    generated_by: `ai:${result.provider}:${result.model}`,
    generated_at: new Date().toISOString(),
  }, null, 2), "utf8");
  console.log(JSON.stringify({ candidate_id: candidateId, profile_path: targetPath, provider: result.provider, model: result.model }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildProfile };
