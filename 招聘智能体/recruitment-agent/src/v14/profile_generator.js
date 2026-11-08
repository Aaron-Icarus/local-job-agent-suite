const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runWithFallback } = require("./ai_providers");
const { importResume } = require("./resumes_repo");

const SKILL_PATH = path.resolve(__dirname, "..", "..", "skills", "resume_profile_skill.md");
const RESUME_DIR = path.resolve(__dirname, "..", "..", "data", "resumes", "files");
const REQUIRED = ["## 基础信息", "## 求职诉求", "## 职业发展期望", "## 工作经历", "## 能力标签", "## 技能关键词", "## 求职偏好/避雷", "## 兜底关键词", "## 风险/需确认"];

function sanitize(text) {
  return String(text || "")
    .replace(/^\s*```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(电话|手机|手机号|邮箱|e-?mail|密码|身份证|微信|QQ|联系方式)\s*[:：]/i.test(line))
    .filter((line) => !/1[3-9]\d{9}/.test(line) && !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(line))
    .join("\n")
    .replace(/\n##\s*每日搜索关键词[\s\S]*?(?=\n##\s|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasProfileStructure(text) {
  return REQUIRED.filter((heading) => String(text || "").includes(heading)).length >= 7;
}

function buildLocalProfile(input, content) {
  const lines = String(content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const name = lines.find((line) => /^#\s*/.test(line))?.replace(/^#+\s*/, "") || input.nickname || "候选人";
  const target = input.target_roles || "待确认";
  const city = input.target_city || "待确认";
  const salary = input.salary_min && input.salary_max ? `${input.salary_min}-${input.salary_max}K` : input.target_salary || "待确认";
  const summary = lines.filter((line) => line.length > 12).slice(0, 8).join("\n- ");
  return sanitize(`# ${name} 角色画像
## 基础信息
- 姓名：${name}
- 目标岗位：${target}
- 目标城市：${city}
- 期望薪资：${salary}
## 求职诉求
- 目标岗位：${target}
- 目标城市：${city}
- 期望薪资：${salary}
- 方向/偏好：待确认
## 职业发展期望
优先 ${target} 方向，具体发展目标待确认。
## 工作经历
- ${summary || "简历内容已保存，工作经历待 AI 整理"}
## 能力标签
- 待从简历中提炼
## 技能关键词
- 待从简历中提炼
## 求职偏好/避雷
- 待用户确认
## 兜底关键词
${target === "待确认" ? "项目经理" : target}
## 风险/需确认
- AI 画像整理未完成，需检查 AI 能力后重新处理
- 城市、薪资、岗位需人工核对`);
}

async function askProfileAI(db, prompt, skill) {
  try {
    const result = await runWithFallback(db, async (provider) => {
      if (provider.type === "codex") throw new Error("Codex 暂不支持画像生成");
      if (!provider.base_url || !provider.api_key) throw new Error("AI 供应商缺少 Base URL/Key");
      const response = await fetch(`${provider.base_url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.api_key}` },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: `你是角色画像整理器。严格遵守 Skill。只输出 Markdown，不要解释。\n\n${skill}` },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || "";
      if (!text) throw new Error("AI 返回为空");
      return { text };
    });
    return result.ok ? { ok: true, text: result.result.text, provider: result.provider?.name || "" } : { ok: false, error: result.errors?.map((item) => item.error).join("；") || "AI 不可用" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function prepareProfile(db, input = {}) {
  fs.mkdirSync(RESUME_DIR, { recursive: true });
  let filePath = "";
  if (input.resume_file_base64) {
    const sourceName = String(input.resume_file_name || "resume.txt");
    const ext = path.extname(sourceName).toLowerCase() || ".txt";
    filePath = path.join(RESUME_DIR, `${crypto.randomUUID()}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(String(input.resume_file_base64).replace(/^data:[^;]+;base64,/, ""), "base64"));
  }
  const content = String(input.resume_md || input.resume_text || "").trim();
  if (!content) {
    return {
      profile_md: sanitize(input.profile_md || ""),
      resume_id: String(input.resume_id || ""),
      file_path: filePath,
      profile_status: "ready",
      profile_error: "",
      provider: "",
    };
  }
  const skill = fs.readFileSync(SKILL_PATH, "utf8");
  let profile = hasProfileStructure(input.profile_md) ? input.profile_md : "";
  let status = "ready";
  let error = "";
  let provider = "";
  if (!profile) {
    const prompt = [
      "根据下面的简历和目标条件生成角色画像。",
      "必须隐藏电话、邮箱、密码、身份证、微信、QQ。",
      "不要在画像中写每日搜索关键词。",
      `目标岗位：${input.target_roles || ""}`,
      `目标城市：${input.target_city || ""}`,
      `薪资：${input.salary_min || ""}-${input.salary_max || ""}K`,
      `职业期望：${input.career_expectation || ""}`,
      `简历原文：\n${content.slice(0, 18000)}`,
    ].join("\n");
    const ai = await askProfileAI(db, prompt, skill);
    if (ai.ok && hasProfileStructure(ai.text)) {
      profile = ai.text;
      provider = ai.provider;
    } else {
      error = ai.error || "AI 返回未符合 Skill 结构";
      profile = buildLocalProfile(input, content);
      status = "pending";
    }
  }
  profile = sanitize(profile);
  if (!hasProfileStructure(profile)) {
    profile = buildLocalProfile(input, content);
    status = "pending";
    if (!error) error = "画像结构不完整，已使用本地兜底";
  }
  let resumeId = String(input.resume_id || "");
  if (!resumeId && content) {
    const resume = importResume(db, {
      name: input.nickname,
      content,
      sourceType: path.extname(String(input.resume_file_name || "")).replace(".", "") || "md",
      fileName: input.resume_file_name || "",
      filePath,
    });
    resumeId = resume.id;
  }
  if (status !== "ready") {
    db.prepare(
      `INSERT INTO profile_tasks(resume_id, file_path, status, error, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`
    ).run(resumeId, filePath, String(error).slice(0, 1000), new Date().toISOString(), new Date().toISOString());
  }
  return { profile_md: profile, resume_id: resumeId, file_path: filePath, profile_status: status, profile_error: error, provider };
}

module.exports = { prepareProfile, buildLocalProfile, hasProfileStructure, RESUME_DIR };
