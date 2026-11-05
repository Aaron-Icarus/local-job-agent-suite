const fs = require("fs");
const path = require("path");
const { runtimeIssues } = require("./runtime_requirements");
const { loadSchedulePolicy } = require("./schedule_policy");
const { loadChannelConfig, platformEnabled } = require("./channel_config");

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

function optionalNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function profileRulesIssues() {
  const issues = [];
  const rulesPath = path.join(rootDir, "config", "profile_rules.json");
  if (!fs.existsSync(rulesPath)) return ["未找到岗位筛选规则 config/profile_rules.json。"];
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
    if (!String(rules.targetLocation || "").trim()) issues.push("岗位筛选规则缺少 targetLocation（目标城市）。");
    const salaryMin = optionalNumber(rules.targetSalaryK?.min);
    const salaryMax = optionalNumber(rules.targetSalaryK?.max);
    if (salaryMin === null || salaryMax === null || salaryMin <= 0 || salaryMax <= 0 || salaryMin > salaryMax) {
      issues.push("岗位筛选规则 targetSalaryK 无效；请填写合理的最低、最高月薪 K 值，例如 20 和 25。");
    }
    const activeHigh = optionalNumber(rules.activityRules?.activeWithinDaysHigh);
    const activeLow = optionalNumber(rules.activityRules?.activeWithinDaysLow);
    const inactive = optionalNumber(rules.activityRules?.inactiveOverDaysIgnore);
    if (activeHigh === null || activeLow === null || inactive === null || activeHigh < 0 || activeHigh > activeLow || activeLow > inactive) {
      issues.push("岗位筛选规则 activityRules 无效；活跃天数阈值应依次递增。");
    }
  } catch (error) {
    issues.push(`岗位筛选规则无法读取：${error.message}`);
  }
  return issues;
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

function scoringConfigIssues() {
  const issues = [];
  const scoringPath = path.join(rootDir, "config", "scoring_rules.json");
  const factsPath = path.join(rootDir, "config", "candidate_facts.json");
  if (!fs.existsSync(scoringPath)) {
    issues.push("未找到评分规则 config/scoring_rules.json；v1.3 的硬条件/软评分需要它。");
  } else {
    try {
      const rules = JSON.parse(fs.readFileSync(scoringPath, "utf8"));
      const weights = rules.weights || {};
      const sum = Object.values(weights).reduce((value, item) => value + (Number(item) || 0), 0);
      if (Math.abs(sum - 1) > 0.001) issues.push(`scoring_rules.json 的权重合计应为 1，当前为 ${sum.toFixed(3)}。`);
      for (const [name, profile] of Object.entries(rules.weight_profiles || {})) {
        const profileSum = Object.values(profile || {}).reduce((value, item) => value + (Number(item) || 0), 0);
        if (Math.abs(profileSum - 1) > 0.001) issues.push(`scoring_rules.json 的 weight_profiles.${name} 权重合计应为 1，当前为 ${profileSum.toFixed(3)}。`);
      }
      if (!rules.keywords || !Array.isArray(rules.keywords.role)) issues.push("scoring_rules.json 缺少 keywords.role。");
    } catch (error) {
      issues.push(`评分规则无法读取：${error.message}`);
    }
  }
  if (fs.existsSync(factsPath)) {
    try {
      JSON.parse(fs.readFileSync(factsPath, "utf8"));
    } catch (error) {
      issues.push(`候选人事实卡无法读取：${error.message}`);
    }
  }
  try {
    const profileRules = JSON.parse(fs.readFileSync(path.join(rootDir, "config", "profile_rules.json"), "utf8"));
    if (!Array.isArray(profileRules.targetRoles) || !profileRules.targetRoles.length) {
      issues.push("profile_rules.json 缺少 targetRoles。");
    }
  } catch (error) {
    issues.push(`岗位筛选规则无法读取：${error.message}`);
  }
  return issues;
}

function validatePreflight() {
  const issues = [];
  const warnings = [];
  issues.push(...runtimeIssues());
  const envPath = configuredEnvPath();
  if (!fs.existsSync(envPath)) issues.push(`未找到配置文件：${envPath}。请从 .env.example 复制为 .env 后填写配置。`);
  const collectEnabled = envBool("ENABLE_COLLECT", false);
  const ingestEnabled = envBool("ENABLE_INGEST", envBool("ENABLE_SCREEN", false));
  const scoreEnabled = envBool("ENABLE_SCORE", envBool("ENABLE_EVALUATE", false));
  const pushEnabled = envBool("ENABLE_PUSH", false);
  let channelResult = null;
  let scheduleResult = null;
  try {
    channelResult = loadChannelConfig();
  } catch (error) {
    issues.push(`平台渠道配置无效：${error.message}`);
  }
  try {
    scheduleResult = loadSchedulePolicy();
  } catch (error) {
    issues.push(`定时策略配置无效：${error.message}`);
  }
  const bossEnabled = channelResult ? platformEnabled(channelResult.config, "boss") : false;
  const liepinEnabled = channelResult ? platformEnabled(channelResult.config, "liepin") : false;
  if (!collectEnabled && !ingestEnabled && !scoreEnabled && !pushEnabled) {
    issues.push("采集、入库、评分和报告均处于关闭状态；请按使用目的至少启用一个阶段。首次使用建议先启用草稿流程，不要直接开启真实发送。");
  }
  if ((collectEnabled || ingestEnabled || scoreEnabled || pushEnabled) && !bossEnabled && !liepinEnabled) {
    issues.push("BOSS 和猎聘整条任务流都已关闭。请至少开启一个平台，或关闭本次所有处理阶段。 ");
  }
  const profileIssue = candidateProfileIssue();
  if (profileIssue) issues.push(profileIssue);
  issues.push(...profileRulesIssues());
  issues.push(...scoringConfigIssues());
  if (collectEnabled && bossEnabled && channelResult?.config.platforms.boss.detail_capture === false) {
    warnings.push("BOSS 当前 detail_capture=false：v1.3 要求入库必须有完整详情，关闭后列表岗位会进入待补，不会入库/编号。");
  }
  if (collectEnabled && liepinEnabled && channelResult?.config.platforms.liepin.detail_capture === false) {
    warnings.push("猎聘当前 detail_capture=false：v1.3 要求入库必须有完整详情，关闭后猎聘岗位会进入待补，不会入库/编号。");
  }
  const sendMode = String(process.env.PREFLIGHT_SEND_MODE || process.env.SEND_MODE || "draft").toLowerCase();
  if (!["draft", "send"].includes(sendMode)) issues.push(`发送模式 ${sendMode || "(空)"} 无效；只能填写 draft 或 send。`);
  else if (sendMode === "send") issues.push(...sendConfigurationIssues());
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    envPath,
    collectEnabled,
    ingestEnabled,
    scoreEnabled,
    bossEnabled,
    liepinEnabled,
    channelConfigPath: channelResult?.filePath || "",
    schedulePolicyPath: scheduleResult?.filePath || "",
    nodeVersion: process.versions.node,
  };
}

function errorText(result) {
  return `【招聘信息智能体配置告警】启动前检查未通过：\n${result.issues.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
}

module.exports = { validatePreflight, errorText, configuredEnvPath };
