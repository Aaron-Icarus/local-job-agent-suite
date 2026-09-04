const fs = require("fs");
const path = require("path");
const { loadEnv, envNumber } = require("../core/load_env");

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
  const apiKey = process.env.PROFILE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.GREETING_OPENAI_API_KEY;
  if (!apiKey) throw new Error("PROFILE_OPENAI_API_KEY, OPENAI_API_KEY, or GREETING_OPENAI_API_KEY is required");
  const baseUrl = (process.env.PROFILE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || process.env.GREETING_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.PROFILE_OPENAI_MODEL || process.env.OPENAI_MODEL || process.env.GREETING_OPENAI_MODEL || "gpt-5.6";
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      store: false,
      instructions: "将求职者提供的简历、补充说明和预期岗位整理成候选人画像 Markdown。只输出 Markdown，不要解释。必须按以下结构：# 当前推荐人画像；## 求职目标；## 最近 3 年优先经历；## 最近 5 年可用经历；## 可验证优势；## 打招呼生成原则。保留时间、公司、职位、职责、项目规模等可验证信息；突出最近三年。不要杜撰，不要保留手机号、邮箱、身份证等敏感信息。",
      input: sourceText.slice(0, 30000),
      text: { format: { type: "text" } },
      max_output_tokens: envNumber("PROFILE_AI_MAX_OUTPUT_TOKENS", 2200),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed with status ${response.status}`);
  const markdown = String(payload.output_text || "").trim();
  if (!markdown) throw new Error("OpenAI response did not contain candidate profile markdown");
  return { markdown, model, candidateId };
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
    generated_by: `ai:${result.model}`,
    generated_at: new Date().toISOString(),
  }, null, 2), "utf8");
  console.log(JSON.stringify({ candidate_id: candidateId, profile_path: targetPath, model: result.model }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildProfile };
