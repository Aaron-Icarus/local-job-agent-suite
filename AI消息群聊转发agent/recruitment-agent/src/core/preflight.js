const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..", "..");

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function configuredEnvPath() {
  const value = process.env.RECRUITMENT_ENV_PATH || ".env";
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function candidateProfileIssue() {
  const profileDir = path.join(rootDir, "config", "candidate_profiles");
  const currentPath = path.join(profileDir, "current.json");
  if (!fs.existsSync(currentPath)) return "未找到候选人画像配置 config/candidate_profiles/current.json。";
  try {
    const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    const profilePath = path.join(profileDir, current.profile_file || "");
    if (!current.profile_file || !fs.existsSync(profilePath)) return "当前候选人画像文件不存在，请先填写并更新 current.json。";
    const text = fs.readFileSync(profilePath, "utf8");
    if (current.current_candidate_id === "sample_candidate" || /候选人画像示例（请替换）/.test(text)) {
      return "候选人画像仍是示例模板；请替换为自己的真实、可验证经历。";
    }
  } catch (error) {
    return `候选人画像无法读取：${error.message}`;
  }
  return "";
}

function sendConfigurationIssues() {
  const issues = [];
  const mode = String(process.env.FEISHU_SEND_MODE || "none").toLowerCase();
  if (mode === "app") {
    for (const key of ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID"]) {
      if (!process.env[key]) issues.push(`发送模式为 app，但缺少 ${key}。`);
    }
  } else if (mode === "webhook") {
    if (!process.env.FEISHU_WEBHOOK_URL) issues.push("发送模式为 webhook，但缺少 FEISHU_WEBHOOK_URL。 ");
  } else {
    issues.push("发送模式为 none；如需真实发送，请配置 FEISHU_SEND_MODE=app 或 webhook。 ");
  }
  return issues;
}

function validatePreflight() {
  const issues = [];
  const envPath = configuredEnvPath();
  if (!fs.existsSync(envPath)) issues.push(`未找到配置文件：${envPath}。请从 .env.example 复制为 .env 后填写配置。`);
  const collectEnabled = envBool("ENABLE_COLLECT", false);
  const bossEnabled = envBool("ENABLE_BOSS", false);
  const liepinEnabled = envBool("ENABLE_LIEPIN", false);
  if (collectEnabled && !bossEnabled && !liepinEnabled) issues.push("已启用采集，但 BOSS 和猎聘均未启用。请至少启用一个平台。 ");
  if (envBool("ENABLE_PUSH", false)) {
    const profileIssue = candidateProfileIssue();
    if (profileIssue) issues.push(profileIssue);
  }
  const sendMode = String(process.env.PREFLIGHT_SEND_MODE || process.env.SEND_MODE || "draft").toLowerCase();
  if (sendMode === "send") issues.push(...sendConfigurationIssues());
  return { ok: issues.length === 0, issues, envPath, collectEnabled, bossEnabled, liepinEnabled };
}

function errorText(result) {
  return `【招聘信息智能体配置告警】启动前检查未通过：\n${result.issues.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
}

module.exports = { validatePreflight, errorText, configuredEnvPath };
