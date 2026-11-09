const fs = require("fs");
const path = require("path");
const { getRole, listRoles } = require("./roles_repo");
const { selectJobsForScoring, saveScore } = require("./scores_repo");
const { runWithFallback } = require("./ai_providers");

const AI_SCORE_SKILL = (() => {
  try {
    return fs.readFileSync(path.resolve(__dirname, "..", "..", "skills", "job_scoring_skill.md"), "utf8");
  } catch {
    return "";
  }
})();

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.round(Math.max(min, Math.min(max, number)));
}

function wordsOf(value) {
  return [...new Set(String(value || "")
    .split(/[、,，/\s；;|]+|或者|以及|或|和|及|与/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2))];
}

function tokensFromPhrase(value) {
  const phrase = String(value || "").trim().toLowerCase();
  if (!phrase) return [];
  const tokens = new Set([phrase]);
  for (const part of phrase.match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) || []) {
    if (part.length >= 2) tokens.add(part);
    if (!/^[\u4e00-\u9fa5]+$/.test(part)) continue;
    for (let size = 2; size <= Math.min(4, part.length); size += 1) {
      for (let index = 0; index + size <= part.length; index += 1) {
        tokens.add(part.slice(index, index + size));
      }
    }
  }
  return [...tokens];
}

function roleTokens(targets) {
  const tokens = new Set();
  for (const target of targets) {
    for (const token of tokensFromPhrase(target)) tokens.add(token);
  }
  return [...tokens];
}

function keywordSignals(keywords) {
  return [...new Set((keywords || [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean))];
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
  const tokens = roleTokens(targets);
  const signals = keywordSignals(keywords);
  const roleExactHits = matchCount(text, targets);
  const roleTokenHits = matchCount(text, tokens);
  const skillExactHits = matchCount(text, keywords);
  const skillTokenHits = matchCount(text, signals);
  const roleExactScore = targets.length ? clamp((roleExactHits / Math.min(2, targets.length)) * 100) : 50;
  const roleTokenScore = tokens.length ? clamp((roleTokenHits / Math.min(4, tokens.length)) * 100) : 50;
  const roleScore = clamp(roleExactScore * 0.4 + roleTokenScore * 0.6);
  const skillExactScore = keywords.length ? clamp((skillExactHits / Math.min(3, keywords.length)) * 100) : 55;
  const skillTokenScore = signals.length ? clamp((skillTokenHits / Math.min(6, signals.length)) * 100) : 55;
  const skillScore = clamp(skillExactScore * 0.5 + skillTokenScore * 0.5);
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
  if (roleExactHits) reasons.push(`岗位标题/职责命中 ${roleExactHits} 个目标岗位词`);
  else if (roleTokenHits) reasons.push(`岗位标题/职责命中 ${roleTokenHits} 个岗位方向词`);
  if (skillExactHits || skillTokenHits) reasons.push(`命中 ${Math.max(skillExactHits, skillTokenHits)} 个角色技能关键词`);
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

function compactJobForAI(job, base) {
  return {
    job_uuid: job.job_uuid,
    display_id: job.display_id,
    platform: job.platform,
    title: job.title,
    company: job.company,
    salary: job.salary_text,
    city: job.city,
    district: job.district,
    experience: job.experience,
    degree: job.degree,
    updated_at: job.job_updated_at,
    recruiter_online: job.recruiter_online,
    recruiter_type: job.recruiter_type,
    jd: String(job.jd_clean_text || job.job_description || "").slice(0, 2200),
    local_score: base.score,
    local_reasons: base.reasons,
    local_risks: base.risks,
  };
}

function parseAIJson(text) {
  const cleaned = String(text || "").replace(/^```json\s*|\s*```$/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.scores) ? parsed.scores : []);
  } catch {
    return [];
  }
}

async function askScoreAI(db, role, rows) {
  const prompt = [
    "你是求职岗位评分器。必须严格按下面的岗位评分 Skill 工作。",
    AI_SCORE_SKILL,
    "AI 评分优先：请直接给出每个岗位 0-100 的最终匹配分，不要只做小幅微调。",
    "本地基线分、理由和风险只作为参考，不是上限；但不得编造简历或岗位事实，不得改变薪资/城市/关闭/重复等硬事实。",
    "每个岗位输出 score（0-100 整数）、reasons（最多 4 条）、risks（最多 4 条）、summary（一句话）。",
    "只输出 JSON：{\"scores\":[{\"job_uuid\":\"...\",\"score\":0,\"reasons\":[\"...\"],\"risks\":[\"...\"],\"summary\":\"...\"}]}",
    `角色目标岗位：${role.target_roles || ""}`,
    `目标城市：${role.target_city || ""}`,
    `期望薪资：${role.target_salary || ""}`,
    `角色画像：${String(role.profile_md || "").slice(0, 3500)}`,
    `岗位：${JSON.stringify(rows)}`,
  ].join("\n");
  const ai = await runWithFallback(db, async (provider) => {
    if (provider.type === "codex") throw new Error("Codex 本地命令不用于岗位评分");
    if (!provider.base_url || !provider.api_key) throw new Error("AI 供应商缺少 Base URL/Key");
    const response = await fetch(`${provider.base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: "你是招聘岗位评分器，只输出 JSON，不编造。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
    const json = await response.json();
    const text = json.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("AI 返回为空");
    return { text, model: provider.model };
  });
  if (!ai.ok) return { ok: false, error: ai.errors?.map((item) => item.error).join("; ") || "AI 未返回结果" };
  return { ok: true, text: ai.result.text, provider: ai.provider?.name || "", model: ai.result.model || "" };
}

async function reviewWithAI(db, role, jobsWithBase, options = {}) {
  const maxRows = Math.max(0, Math.min(200, Number(options.aiMaxRows || process.env.AI_SCORE_MAX_ROWS || 200)));
  const batchSize = Math.max(1, Math.min(12, Number(options.aiBatchSize || process.env.AI_SCORE_BATCH_SIZE || 6)));
  const selected = jobsWithBase.slice(0, maxRows);
  const reviewed = new Map();
  const errors = [];
  let provider = "";
  let model = "";
  for (let index = 0; index < selected.length; index += batchSize) {
    const batch = selected.slice(index, index + batchSize);
    try {
      const ai = await askScoreAI(db, role, batch.map((item) => compactJobForAI(item.job, item.base)));
      if (!ai.ok) { errors.push(ai.error); continue; }
      provider = ai.provider || provider;
      model = ai.model || model;
      for (const item of parseAIJson(ai.text)) {
        const key = String(item.job_uuid || item.job_id || item.display_id || item.index || "");
        if (!key) continue;
        if (!Number.isFinite(Number(item.score ?? item.overall_score ?? item.overall))) {
          errors.push(`AI 未返回有效 score：${key}`);
          continue;
        }
        reviewed.set(key, item);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  // 批量返回漏项时逐个补一次，避免无谓回退本地分。
  const missing = selected.filter((item) => !reviewed.has(String(item.job.job_uuid)) && !reviewed.has(String(item.job.display_id))).slice(0, 20);
  for (const item of missing) {
    try {
      const ai = await askScoreAI(db, role, [compactJobForAI(item.job, item.base)]);
      if (!ai.ok) { errors.push(ai.error); continue; }
      provider = ai.provider || provider;
      model = ai.model || model;
      for (const result of parseAIJson(ai.text)) {
        const key = String(result.job_uuid || result.job_id || result.display_id || result.index || "");
        if (!key) continue;
        if (Number.isFinite(Number(result.score ?? result.overall_score ?? result.overall))) reviewed.set(key, result);
        else errors.push(`AI 未返回有效 score：${key}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { reviewed, provider, model, errors, attempted: selected.length };
}

function applyAIScore(base, review, provider) {
  const value = Number(review?.score ?? review?.overall_score ?? review?.overall);
  if (!Number.isFinite(value)) return null;
  const score = clamp(value);
  const reasons = Array.isArray(review?.reasons) ? review.reasons.map(String).filter(Boolean).slice(0, 4) : [];
  const risks = Array.isArray(review?.risks) ? review.risks.map(String).filter(Boolean).slice(0, 4) : [];
  return {
    score,
    tier: score >= 80 ? "高" : score >= 60 ? "中" : "低",
    explanation: String(review?.summary || "").slice(0, 300) || `AI 评分 ${score}`,
    reasons: reasons.length ? reasons : base.reasons,
    risks: risks.length ? risks : base.risks,
    scoreVersion: "v1.5.3-ai-first",
    aiUsed: true,
    aiProvider: provider || "",
  };
}

async function scoreRoleJobs(db, roleUuid, options = {}) {
  const role = getRole(db, roleUuid);
  if (!role || role.deleted_at) return { roleUuid, scored: 0 };
  const jobs = selectJobsForScoring(db, roleUuid, { limit: options.limit || 200 });
  const jobsWithBase = jobs.map((job) => ({ job, base: scoreJob(job, role) }));
  const aiDisabled = options.ai === false || options.localOnly;
  const ai = aiDisabled
    ? { reviewed: new Map(), provider: "", model: "", errors: [], attempted: 0 }
    : await reviewWithAI(db, role, jobsWithBase, options);
  let scored = 0;
  let aiUsed = 0;
  for (const item of jobsWithBase) {
    const review = ai.reviewed.get(String(item.job.job_uuid)) || ai.reviewed.get(String(item.job.display_id));
    const aiScore = review ? applyAIScore(item.base, review, ai.provider) : null;
    const score = aiScore || item.base;
    if (aiScore) aiUsed += 1;
    saveScore(db, roleUuid, item.job.job_uuid, score);
    scored += 1;
  }
  return {
    roleUuid,
    roleNumber: role.role_number,
    nickname: role.nickname,
    scored,
    aiUsed,
    aiAttempted: ai.attempted,
    aiProvider: ai.provider,
    aiModel: ai.model,
    aiError: ai.errors.join("; ").slice(0, 1000),
  };
}

async function scoreAllRoles(db, options = {}) {
  const results = [];
  for (const role of listRoles(db)) {
    if (role.deleted_at) continue;
    results.push(await scoreRoleJobs(db, role.role_uuid, options));
  }
  return { scored: results.reduce((sum, item) => sum + item.scored, 0), roles: results };
}

module.exports = { scoreJob, scoreRoleJobs, scoreAllRoles };
