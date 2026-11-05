const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadCurrentCandidateProfile } = require("../greeting/candidate_profile");

const rootDir = path.resolve(__dirname, "..", "..");
const rulesPath = path.join(rootDir, "config", "profile_rules.json");
const factsPath = path.join(rootDir, "config", "candidate_facts.json");
const scoringRulesPath = path.join(rootDir, "config", "scoring_rules.json");

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

function deriveAllowPureTech(targetRoles, overlay) {
  if (typeof overlay.allow_pure_tech === "boolean") return overlay.allow_pure_tech;
  const text = (targetRoles || []).join(" ");
  return /开发|研发|工程师|后端|前端|全栈|算法|测试|运维/.test(text);
}

// 候选人事实卡 = profile_rules.json（人的偏好）+ candidate_facts.json（可选覆盖层）+ 当前画像正文摘要。
// 这样用户只维护原有的 profile_rules，也能得到一条可解释的“事实卡”。
function loadCandidateFacts(options = {}) {
  const profileRules = readJson(options.profileRulesPath || rulesPath, {});
  const overlay = readJson(options.factsPath || factsPath, {});
  let profile = null;
  try {
    profile = loadCurrentCandidateProfile();
  } catch {
    profile = null;
  }

  const targetSalary = overlay.target_salary_k || profileRules.targetSalaryK || {};
  const targetMin = Number(targetSalary.min);
  const targetMax = Number(targetSalary.max);
  const targetRoles = uniqueStrings([
    ...(overlay.target_roles || []),
    ...(profileRules.targetRoles || []),
  ]);
  const roleFamily = /开发|研发|工程师|后端|前端|全栈|算法|测试|运维/.test(targetRoles.join(" ")) ? "engineering" : "project_product";
  const strengths = uniqueStrings([
    ...(overlay.strengths || []),
    ...(profileRules.preferredTopics || []),
  ]);
  const cities = uniqueStrings([
    ...(overlay.cities || []),
    ...(overlay.acceptable_cities || []),
    ...(profileRules.targetLocation ? [profileRules.targetLocation] : []),
  ]);
  const avoidJd = uniqueStrings([
    ...(overlay.avoid_jd_keywords || []),
    ...(profileRules.avoidTopics || []),
  ]);
  const avoidTitle = uniqueStrings(overlay.avoid_title_keywords || []);
  const floorValue = overlay.hard_salary_floor_k == null ? targetMin : Number(overlay.hard_salary_floor_k);
  const facts = {
    version: Number(overlay.version || 1),
    profile_id: profile?.id || "current_candidate",
    profile_version: profile?.version || 1,
    profile_excerpt: (profile?.markdown || "").slice(0, 6000),
    cities,
    accept_remote: overlay.accept_remote === true,
    target_salary_k: {
      min: Number.isFinite(targetMin) ? targetMin : null,
      max: Number.isFinite(targetMax) ? targetMax : null,
      floor: Number.isFinite(floorValue) ? floorValue : null,
    },
    target_roles: targetRoles,
    role_family: roleFamily,
    strengths,
    avoid_title_keywords: avoidTitle,
    avoid_jd_keywords: avoidJd,
    preferred_industries: uniqueStrings(overlay.preferred_industries || []),
    allow_pure_tech: deriveAllowPureTech(targetRoles, overlay),
    activity_rules: profileRules.activityRules || {},
    lower_priority_districts: uniqueStrings(profileRules.lowerPriorityDistricts || []),
    notes: String(overlay.notes || ""),
  };
  return { facts, version: hash(facts), paths: { rulesPath, factsPath, profilePath: profile?.path || "" } };
}

function loadScoringRules(options = {}) {
  const rules = readJson(options.scoringRulesPath || scoringRulesPath, {});
  const weights = rules.weights || {};
  const weightSum = Object.values(weights).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { rules, version: hash(rules), weightSum: Number(weightSum.toFixed(4)) };
}

module.exports = {
  loadCandidateFacts,
  loadScoringRules,
  readJson,
  rulesPath,
  factsPath,
  scoringRulesPath,
};
