const { getRole, listRoles } = require("./roles_repo");
const { selectJobsForScoring, saveScore } = require("./scores_repo");

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.round(Math.max(min, Math.min(max, number)));
}

function wordsOf(value) {
  return [...new Set(String(value || "")
    .split(/[、,，/\s;；|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2))];
}

function jobText(job) {
  return [job.title, job.company, job.city, job.district, job.jd_clean_text || job.job_description].join(" ").toLowerCase();
}

function matchCount(text, words) {
  return words.filter((word) => text.includes(String(word).toLowerCase())).length;
}

function salaryMatch(job, role) {
  const min = Number(job.salary_min_k);
  const max = Number(job.salary_max_k);
  const targetMin = Number(role.salary_min);
  const targetMax = Number(role.salary_max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 55;
  if (!Number.isFinite(targetMin) || !Number.isFinite(targetMax)) return 65;
  if (max < targetMin) return 15;
  if (min <= targetMin && max >= targetMax) return 100;
  if (min <= targetMax && max >= targetMin) return 82;
  return 55;
}

function cityMatch(job, role) {
  const text = `${job.city || ""} ${job.district || ""} ${job.address || ""}`;
  const cities = Array.isArray(role.target_cities) ? role.target_cities : [];
  if (!cities.length) return 70;
  for (const item of cities) {
    if (item.city && item.city !== "全部" && text.includes(String(item.city).replace(/市$/, ""))) return 95;
    if (item.province && text.includes(String(item.province).replace(/省|市$/, ""))) return 88;
    if (item.district && item.district !== "全部" && text.includes(String(item.district).replace(/区|市$/, ""))) return 98;
  }
  return 35;
}

function daysSince(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((Date.now() - time) / 86400000);
}

function onlineDays(value) {
  const text = String(value || "");
  if (/刚刚|今日|在线/.test(text)) return 0;
  const match = text.match(/(\d+)\s*天/);
  return match ? Number(match[1]) : null;
}

function scoreJob(job, role) {
  const text = jobText(job);
  const targets = wordsOf(role.target_roles);
  const keywords = Array.isArray(role.role_keywords) ? role.role_keywords.map((item) => String(item)) : [];
  const roleHits = matchCount(text, targets);
  const skillHits = matchCount(text, keywords);
  const roleScore = targets.length ? clamp((roleHits / Math.min(3, targets.length)) * 100) : 50;
  const skillScore = keywords.length ? clamp((skillHits / Math.min(4, keywords.length)) * 100) : 55;
  const salary = salaryMatch(job, role);
  const city = cityMatch(job, role);
  const active = /当前在线|刚刚活跃|今日活跃|今天活跃|在线/.test(String(job.recruiter_online || job.job_description || "")) ? 95 : 65;
  let freshnessPenalty = 0;
  const updateAge = daysSince(job.job_updated_at);
  const recruiterAge = onlineDays(job.recruiter_online);
  if (updateAge != null && updateAge > 180) freshnessPenalty += 15;
  else if (updateAge != null && updateAge > 90) freshnessPenalty += 8;
  if (recruiterAge != null && recruiterAge > 7) freshnessPenalty += 20;
  else if (recruiterAge != null && recruiterAge > 3) freshnessPenalty += 10;
  const overall = clamp(roleScore * 0.42 + skillScore * 0.28 + salary * 0.12 + city * 0.12 + active * 0.06 - freshnessPenalty);
  const tier = overall >= 80 ? "高" : overall >= 60 ? "中" : "低";
  const reasons = [];
  const risks = [];
  if (roleHits) reasons.push(`岗位标题/职责命中 ${roleHits} 个目标岗位词`);
  if (skillHits) reasons.push(`命中 ${skillHits} 个角色技能关键词`);
  if (salary >= 85) reasons.push("薪资与期望区间重叠");
  else if (salary < 40) risks.push("薪资低于期望下限");
  if (city >= 85) reasons.push("工作地点符合目标城市");
  else risks.push("工作地点与目标城市不完全匹配");
  if (updateAge != null && updateAge > 90) risks.push(`岗位已 ${updateAge} 天未更新`);
  if (recruiterAge != null && recruiterAge > 7) risks.push(`招聘方 ${recruiterAge} 天未在线，联系可能性低`);
  else if (recruiterAge != null && recruiterAge > 3) risks.push(`招聘方 ${recruiterAge} 天未在线`);
  if (!job.jd_clean_text && (!job.job_description || job.job_description.length < 80)) risks.push("岗位详情偏少，需人工确认");
  return {
    score: overall,
    tier,
    explanation: reasons.join("；") || "与角色目标关联较弱",
    reasons,
    risks,
    scoreVersion: "v1.5-local-fit",
  };
}

function scoreRoleJobs(db, roleUuid, options = {}) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) return { roleUuid, scored: 0 };
  const jobs = selectJobsForScoring(db, roleUuid, { limit: options.limit || 200 });
  let scored = 0;
  for (const job of jobs) {
    saveScore(db, roleUuid, job.job_uuid, scoreJob(job, role));
    scored += 1;
  }
  return { roleUuid, roleNumber: role.role_number, nickname: role.nickname, scored };
}

function scoreAllRoles(db, options = {}) {
  const results = [];
  for (const role of listRoles(db)) {
    if (role.deleted_at) continue;
    results.push(scoreRoleJobs(db, role.role_uuid, options));
  }
  return { scored: results.reduce((sum, item) => sum + item.scored, 0), roles: results };
}

module.exports = { scoreJob, scoreRoleJobs, scoreAllRoles };
