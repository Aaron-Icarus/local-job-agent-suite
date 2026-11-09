const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { nowIso } = require("./jobs_repo");
const { importResume } = require("./resumes_repo");
const { parseResumeMarkdown, resumeToProfileMarkdown } = require("./resume_parser");
const { searchRoleJobs } = require("./scores_repo");
const { getRole } = require("./roles_repo");
const { runWithFallback } = require("./ai_providers");
const keywordService = require("./keyword_service");

const KNOWN_CITIES = ["上海", "北京", "深圳", "广州", "杭州", "苏州", "成都", "武汉", "南京", "西安", "重庆"];
const KEYWORD_SKILL = (() => {
  try { return fs.readFileSync(path.resolve(__dirname, "..", "..", "skills", "daily_keyword_skill.md"), "utf8"); } catch { return ""; }
})();
const PROFILE_SKILL = (() => {
  try { return fs.readFileSync(path.resolve(__dirname, "..", "..", "skills", "resume_profile_skill.md"), "utf8"); } catch { return ""; }
})();

function safeJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

async function askAI(db, prompt) {
  try {
    const result = await runWithFallback(db, async (provider) => {
      if (provider.type === "codex") throw new Error("Codex 本地命令暂不用于聊天");
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
            { role: "system", content: "你是本地招聘助手的对话模块。只使用用户提供的事实，不编造。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || "";
      if (!text) throw new Error("AI 返回为空");
      return { text };
    });
    return result.ok ? { text: result.result.text, provider: result.provider.name } : null;
  } catch {
    return null;
  }
}

function createSession(db, input = {}) {
  const externalKey = String(input.externalKey || "");
  if (externalKey) {
    const existing = db.prepare("SELECT id FROM chat_sessions WHERE external_key = ?").get(externalKey);
    if (existing) return getSession(db, existing.id);
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO chat_sessions(id, title, role_uuid, external_key, state_json, created_at, updated_at) VALUES(?, ?, ?, ?, '{}', ?, ?)"
  ).run(id, String(input.title || "新对话"), String(input.roleUuid || ""), externalKey, now, now);
  return getSession(db, id);
}

function listSessions(db) {
  return db.prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 50").all();
}

function getSession(db, id) {
  const session = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
  if (!session) return null;
  return {
    ...session,
    state: safeJson(session.state_json, {}),
    messages: db.prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC").all(id).map((row) => ({
      ...row,
      metadata: safeJson(row.metadata_json, {}),
    })),
  };
}

function appendMessage(db, sessionId, role, content, metadata = {}) {
  const now = nowIso();
  db.prepare(
    "INSERT INTO chat_messages(session_id, role, content, metadata_json, created_at) VALUES(?, ?, ?, ?, ?)"
  ).run(sessionId, role, String(content || ""), JSON.stringify(metadata), now);
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
}

function updateState(db, sessionId, state) {
  db.prepare("UPDATE chat_sessions SET state_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(state),
    nowIso(),
    sessionId
  );
}

function extractField(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n；;]+)`));
    if (match) return match[1].trim();
  }
  return "";
}

function extractCities(text) {
  return KNOWN_CITIES.filter((city) => text.includes(city));
}

function extractSalary(text) {
  const match = text.match(/(\d+)\s*[-~到至]\s*(\d+)\s*[kK]/);
  return match ? `${match[1]}-${match[2]}K` : "";
}

function extractExperience(text) {
  const match = text.match(/(\d+)\s*年/);
  return match ? `${match[1]} 年` : "";
}

function inferTargetRole(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 120) return "";
  const match = value.match(/([A-Za-z0-9+\/\u4e00-\u9fa5]{2,24}(?:项目经理|产品经理|工程师|顾问|专员|主管|总监|设计师|分析师|架构师|运营|开发|交付))/);
  return match ? match[1].trim() : "";
}

function dailyKeywords(state) {
  const targets = String(state.target_roles || "").split(/[、,，/]/).map((item) => item.trim()).filter(Boolean);
  const skills = (state.parsed?.skills || []).map((item) => String(item).trim()).filter(Boolean);
  const text = `${state.resume_md || ""} ${targets.join(" ")} ${skills.join(" ")}`;
  const keywords = new Set();
  for (const target of targets) {
    keywords.add(target);
    if (/AI|智能体|大模型/i.test(text)) {
      keywords.add(`${target} 智能体`);
      keywords.add(`${target} 大模型`);
    }
  }
  if (/AI|智能体|大模型|Agent/i.test(text)) {
    ["AI Agent", "智能体交付", "大模型应用", "私有化部署", "AI项目管理", "AI产品经理"].forEach((item) => keywords.add(item));
  }
  for (const skill of skills) if (skill.length <= 20) keywords.add(skill);
  return [...keywords].slice(0, 12);
}

function normalizeKeywordSections(text) {
  let result = String(text || "");
  for (const heading of ["技能关键词", "兜底关键词"]) {
    const pattern = new RegExp(`(##\\s*${heading}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`);
    result = result.replace(pattern, (_, title, body) => {
      const items = [...new Set(String(body)
        .split(/[\n,，、]/)
        .map((item) => item.replace(/^[-*\d.\s]+/, "").trim())
        .filter(Boolean))];
      return `${title}${items.join("、")}`;
    });
  }
  return result;
}

function sanitizeProfile(text) {
  let result = String(text || "");
  result = result.replace(/\n##\s*每日搜索关键词[\s\S]*?(?=\n##\s|$)/g, "\n");
  result = result.split(/\r?\n/).filter((line) => {
    if (/^\s*(电话|手机|手机号|邮箱|e-?mail|密码|身份证|微信|QQ|联系方式)\s*[:：]/i.test(line)) return false;
    if (/1[3-9]\d{9}/.test(line) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(line)) return false;
    return true;
  }).join("\n");
  return normalizeKeywordSections(result.replace(/\n{3,}/g, "\n\n").trim());
}

function parseKeywordList(text) {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    // fall through to line parsing
  }
  return raw.split(/[,\n，、]/).map((item) => item.replace(/^[-*\d.\s"]+|["\]]+$/g, "").trim()).filter((item) => item && item.length <= 40);
}

function uniqueKeywords(list, limit) {
  return [...new Set((list || []).map((item) => String(item).trim()).filter(Boolean))].slice(0, limit);
}

function parseKeywordPayload(text) {
  try {
    const parsed = JSON.parse(String(text || "").replace(/^```json\s*|\s*```$/g, ""));
    if (Array.isArray(parsed)) return { recommended: parsed, fallback: [] };
    if (parsed && typeof parsed === "object") {
      return {
        recommended: Array.isArray(parsed.recommended) ? parsed.recommended : (Array.isArray(parsed.keywords) ? parsed.keywords : []),
        fallback: Array.isArray(parsed.fallback) ? parsed.fallback : [],
      };
    }
  } catch {
    // fall through
  }
  return { recommended: parseKeywordList(text), fallback: [] };
}

async function generateKeywords(db, state) {
  const base = keywordService.fallbackKeywords({
    ...state,
    skills: state.parsed?.skills || [],
  });
  const history = keywordService.history(db, state.role_uuid).slice(0, 12);
  const ai = await askAI(db, [
    "你是招聘搜索关键词生成器。用户画像和求职意愿权重最高，历史关键词效果只用于调整。",
    "严格按下面的 Skill 执行：",
    KEYWORD_SKILL,
    "生成 8-12 个中文/英文搜索关键词，并额外给 3-5 个默认兜底词。",
    "只输出 JSON：{\"recommended\":[\"...\"],\"fallback\":[\"...\"]}。",
    "关键词要具体，覆盖岗位名、行业/技术方向、同义词；不要把城市、薪资、姓名、电话、邮箱写进关键词。",
    "如果历史里某个词近期被大量使用、重复率高或失败多，本轮应降低权重或换成新词；保留仍有效的词。",
    `目标岗位：${state.target_roles || ""}`,
    `目标城市：${state.target_city || ""}`,
    `薪资：${state.target_salary || ""}`,
    `职业期望（高权重）：${state.career_expectation || ""}`,
    `画像：${sanitizeProfile(state.profile_md || buildProfile(state))}`,
    `历史关键词及效果：${JSON.stringify(history)}`,
    `本地兜底候选：${JSON.stringify(base)}`,
    `简历摘要：${String(state.experience || state.parsed?.experience_summary || "").slice(0, 1500)}`,
  ].join("\n"));
  const parsed = ai?.text ? parseKeywordPayload(ai.text) : { recommended: [], fallback: [] };
  const recent = new Set(history.slice(0, 3).map((item) => String(item.keyword).toLowerCase()));
  const proposed = parsed.recommended.length ? parsed.recommended : base.recommended;
  const rotated = proposed.filter((item) => !recent.has(String(item).toLowerCase()));
  const recommended = uniqueKeywords(rotated.length >= 5 ? rotated : proposed, 12);
  const fallback = uniqueKeywords([
    ...parsed.fallback,
    ...base.fallback,
    "项目主管",
    "PMO",
    "交付经理",
    "项目协调",
    "运营主管",
  ].filter((item) => !recommended.includes(item)), 5);
  if (state.role_uuid) {
    keywordService.save(db, state.role_uuid, { recommended, fallback });
  }
  return {
    keywords: recommended,
    fallbackKeywords: fallback,
    aiUsed: Boolean(ai && parsed.recommended.length),
    provider: ai?.provider || "",
    historyUsed: history.length,
  };
}

function buildProfile(state) {
  const parsed = state.parsed || {};
  const skills = (parsed.skills || []).join("、") || "-";
  const fallbackKeywords = uniqueKeywords(
    state.fallback_keywords || keywordService.fallbackKeywords({ ...state, skills: parsed.skills || [] }).fallback,
    5
  );
  const preferences = state.preferences || "希望岗位方向与目标一致；具体偏好待确认。";
  const profile = [
    `# ${parsed.name || "候选人"} 角色画像`,
    "",
    `## 基础信息\n- 姓名：${parsed.name || "-"}\n- 学历：${parsed.education || "-"}\n- 目标岗位：${state.target_roles || "-"}\n- 目标城市：${state.target_city || "-"}\n- 期望薪资：${state.target_salary || "-"}`,
    `## 求职诉求\n- 目标岗位：${state.target_roles || "-"}\n- 目标城市：${state.target_city || "-"}\n- 期望薪资：${state.target_salary || "-"}\n- 方向/偏好：${state.career_expectation || preferences}`,
    `## 职业发展期望\n${state.career_expectation || `希望在${state.target_city || "目标城市"}从事${state.target_roles || "目标岗位"}，薪资${state.target_salary || "面议"}；具体方向待确认。`}`,
    `## 工作经历\n${state.experience || parsed.experience_summary || "-"}`,
    `## 能力标签\n${skills}`,
    `## 技能关键词\n${skills}`,
    `## 求职偏好/避雷\n${preferences}`,
    `## 兜底关键词\n${fallbackKeywords.join("、")}`,
    `## 风险/需确认\n${state.risk || "请人工核对简历事实与期望薪资"}`,
    "",
    "> 由本地简历解析 + 角色画像 Skill 生成；请人工确认事实后再启用角色；下一轮搜索关键词在角色关键词中单独维护。",
  ].join("\n");
  return sanitizeProfile(profile);
}

function ensureProfileSections(profile, localProfile) {
  const required = ["## 求职诉求", "## 职业发展期望", "## 技能关键词", "## 求职偏好/避雷", "## 兜底关键词", "## 风险/需确认"];
  const missing = required.filter((heading) => !String(profile).includes(heading));
  if (!missing.length) return sanitizeProfile(profile);
  const sections = {};
  for (const heading of required) {
    const start = localProfile.indexOf(heading);
    if (start < 0) continue;
    const next = localProfile.indexOf("\n## ", start + heading.length);
    sections[heading] = localProfile.slice(start, next < 0 ? localProfile.length : next).trim();
  }
  return sanitizeProfile(`${profile.trim()}\n\n${missing.map((heading) => sections[heading] || "").filter(Boolean).join("\n\n")}`);
}

function replaceFallbackSection(profile, fallback = []) {
  const keywords = uniqueKeywords(fallback, 8);
  if (!keywords.length) return profile;
  const section = `## 兜底关键词\n${keywords.join("、")}`;
  if (/##\s*兜底关键词/.test(profile)) {
    return profile.replace(/\n##\s*兜底关键词[\s\S]*?(?=\n##\s|$)/, `\n${section}`);
  }
  const risk = profile.indexOf("## 风险/需确认");
  if (risk < 0) return `${profile.trim()}\n\n${section}`;
  return `${profile.slice(0, risk).trim()}\n\n${section}\n\n${profile.slice(risk).trim()}`;
}

function findJobByText(db, roleUuid, text) {
  const match = String(text || "").match(/\b([A-Z]\d{3,4})\b/);
  if (!match) return null;
  return db.prepare(
    `SELECT rj.*, j.display_id, j.company, j.title, j.job_url, j.salary_text, j.city, j.district,
            j.job_description, j.first_seen_date, j.last_seen_date
     FROM role_jobs rj JOIN jobs j ON j.job_uuid = rj.job_uuid
     WHERE rj.role_uuid = ? AND j.display_id = ? LIMIT 1`
  ).get(roleUuid, match[1]);
}

async function greetingReply(db, state, text) {
  if (!state.role_uuid) return { text: "先选择一个角色，我才能结合画像写打招呼。", metadata: { action: "need_role" } };
  const role = getRole(db, state.role_uuid);
  const job = findJobByText(db, state.role_uuid, text);
  const jdText = job?.job_description || String(text).replace(/^.*?JD[:：]?/i, "").trim();
  if (!jdText) return { text: "请给我岗位编号（例如 A001）或粘贴 JD，我再结合角色画像写打招呼。", metadata: { action: "need_job" } };
  const prompt = [
    "你是求职者本人。根据角色画像和岗位 JD，写一段 100-200 字的中文招聘平台打招呼。",
    "不要编造简历中没有的经历；语气专业、具体、有项目结果。",
    `角色画像：${role?.profile_md || ""}`,
    `岗位：${job ? `${job.display_id} ${job.company} ${job.title}` : "用户粘贴岗位"}`,
    `JD：${jdText}`,
  ].join("\n");
  const ai = await askAI(db, prompt);
  const fallback = `您好，我有 ${role?.target_roles || "AI/项目交付"} 相关经验，做过企业 AGI 智能体、私有化算力平台和 AIGC 项目交付，熟悉需求调研、UAT、验收和跨团队推进。看到贵司「${job?.title || "该岗位"}」与我的项目经历匹配，期待进一步沟通。`;
  const reply = ai?.text || fallback;
  return {
    text: `${job ? `岗位 ${job.display_id} ${job.company} - ${job.title}\n` : ""}${reply}`,
    metadata: { action: "greeting", job_id: job?.display_id || "", ai_used: Boolean(ai), greeting: reply },
  };
}

function jobSearchReply(db, state) {
  if (!state.role_uuid) return { text: "先选择一个角色，我才能按角色评分查岗位。", metadata: { action: "need_role" } };
  const role = getRole(db, state.role_uuid);
  const result = searchRoleJobs(db, state.role_uuid, { page: 1, pageSize: 8, sort: "score_desc" });
  if (!result.jobs.length) return { text: `角色 ${role?.nickname || ""} 目前没有可推荐岗位。`, metadata: { action: "job_search", jobs: [] } };
  const lines = result.jobs.map((job, index) => `${index + 1}. ${job.display_id} ${job.company} - ${job.title}（${job.score ?? "-"} 分，${job.city || "-"}）`);
  return {
    text: `按角色「${role?.nickname || ""}」找到 ${result.total} 个岗位，先看前 ${lines.length} 个：\n\n${lines.join("\n")}\n\n可以继续告诉我地点/薪资/关键词，我再缩小范围。`,
    metadata: { action: "job_search", jobs: result.jobs.map((job) => ({ id: job.display_id, jobUuid: job.job_uuid, score: job.score })) },
  };
}

async function runTurn(db, sessionId, input = {}) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error("对话不存在");
  const text = String(input.text || "").trim();
  const state = { ...session.state };
  if (input.roleUuid) state.role_uuid = input.roleUuid;

  appendMessage(db, sessionId, "user", text || (input.resume_md ? "（上传简历）" : ""), {
    hasResume: Boolean(input.resume_md),
  });

  if (input.resume_md) {
    const parsed = parseResumeMarkdown(input.resume_md);
    const resume = importResume(db, {
      name: parsed.name,
      content: input.resume_md,
      fileName: input.resume_file_name || "",
    });
    state.resume_md = input.resume_md;
    state.resume_id = resume.id;
    state.parsed = parsed;
    if (!state.target_roles && parsed.target_roles?.length) state.target_roles = parsed.target_roles.join("、");
    if (!state.experience && parsed.experience_summary) state.experience = parsed.experience_summary;
  } else if (state.resume_md && !state.parsed?.experience_summary) {
    // 兼容旧版本已导入的纯文本 DOCX 简历：旧解析器把整份简历放在“未分类”，这里重新解析字段。
    try {
      const parsed = parseResumeMarkdown(state.resume_md);
      state.parsed = parsed;
      if (!state.target_roles && parsed.target_roles?.length) state.target_roles = parsed.target_roles.join("、");
      if (!state.experience && parsed.experience_summary) state.experience = parsed.experience_summary;
    } catch {
      // 保留旧状态，下一轮仍可人工补充
    }
  }

  const targetRoles = input.target_roles
    || extractField(text, ["目标岗位", "求职意向", "期望岗位"])
    || inferTargetRole(text);
  const targetCity = input.target_city || extractField(text, ["目标城市", "城市", "地点"]) || extractCities(text)[0] || "";
  const targetSalary = input.target_salary || extractSalary(text);
  const experience = input.experience
    || extractExperience(text)
    || state.parsed?.experience_summary
    || (state.resume_md ? String(state.resume_md).slice(0, 2000) : "");
  const careerExpectation = input.career_expectation || extractField(text, ["职业发展期望", "期望方向", "发展方向"]);
  if (targetRoles) state.target_roles = targetRoles;
  if (targetCity) state.target_city = targetCity;
  if (targetSalary) state.target_salary = targetSalary;
  if (experience) state.experience = experience;
  if (careerExpectation) state.career_expectation = careerExpectation;
  if (input.preferences) state.preferences = input.preferences;

  const wantsGreeting = /打招呼|招呼话术|写招呼/.test(text);
  if (wantsGreeting) {
    const reply = await greetingReply(db, state, text);
    appendMessage(db, sessionId, "assistant", reply.text, reply.metadata);
    updateState(db, sessionId, state);
    return { session: getSession(db, sessionId), reply };
  }

  const wantsJobDetail = /JD|jd|详情|评分|日报/.test(text) && /[A-Z]\d{3,4}/.test(text);
  if (wantsJobDetail) {
    const job = findJobByText(db, state.role_uuid, text);
    if (!job) {
      const reply = "没有找到这个岗位编号；请确认编号，或先让我按角色查岗位。";
      appendMessage(db, sessionId, "assistant", reply, { action: "job_not_found" });
      return { session: getSession(db, sessionId), reply };
    }
    const textReply = [
      `${job.display_id} ${job.company} - ${job.title}`,
      `薪资：${job.salary_text || "-"}`,
      `地点：${job.city || "-"}${job.district ? ` ${job.district}` : ""}`,
      `评分：${job.score ?? "-"}（${job.tier || "未分级"}）`,
      `链接：${job.job_url || "-"}`,
      `JD：${String(job.job_description || "").slice(0, 1200) || "-"}`,
    ].join("\n");
    appendMessage(db, sessionId, "assistant", textReply, { action: "job_detail", job_id: job.display_id });
    updateState(db, sessionId, state);
    return { session: getSession(db, sessionId), reply: { text: textReply } };
  }

  const wantsJobs = /岗位|推荐|搜索|合适|机会/.test(text) && !/生成画像|画像/.test(text);
  if (wantsJobs) {
    const reply = jobSearchReply(db, state);
    appendMessage(db, sessionId, "assistant", reply.text, reply.metadata);
    updateState(db, sessionId, state);
    return { session: getSession(db, sessionId), reply };
  }

  if (/测试密码|测试\s*secret|test\s*secret/i.test(text)) {
    const reply = "没有预设的“测试密码”。如果你在验证通道，请发送一条带时间戳的测试消息；我收到后会原样确认，不需要密码。";
    appendMessage(db, sessionId, "assistant", reply, { action: "test_no_password" });
    updateState(db, sessionId, state);
    return { session: getSession(db, sessionId), reply };
  }

  const wantsProfile = /画像|简历|生成|角色/.test(text);
  if (!wantsProfile && text) {
    const ai = await askAI(db, text);
    if (ai) {
      const metadata = { action: "ai_reply", ai_used: true, provider: ai.provider, steps: ["observe", "think", "respond"] };
      appendMessage(db, sessionId, "assistant", ai.text, metadata);
      updateState(db, sessionId, state);
      return { session: getSession(db, sessionId), reply: { text: ai.text, ...metadata } };
    }
  }

  const missing = [];
  if (!state.resume_md) missing.push("简历（上传 .md 或粘贴）");
  if (!state.target_roles) missing.push("目标岗位");
  if (!state.target_city) missing.push("目标城市");
  if (!state.target_salary) missing.push("目标薪资区间");
  if (!state.experience) missing.push("相关经历");

  if (missing.length) {
    const reply = `我先按角色画像 Skill 检查了一下，还缺：\n${missing.map((item) => `- ${item}`).join("\n")}\n\n可以一次发给我，例如：“目标岗位：实施顾问；城市：上海；薪资：18-25K；5 年企业软件实施经验”。`;
    appendMessage(db, sessionId, "assistant", reply, { action: "ask_missing", missing, steps: ["parse_resume", "ask_missing"] });
    updateState(db, sessionId, state);
    return { session: getSession(db, sessionId), reply };
  }

  const profileLocal = buildProfile(state);
  const aiProfile = await askAI(db, [
    "请严格按下面的角色画像 Skill 生成一份角色画像 Markdown，只输出 Markdown，不要编造事实。",
    PROFILE_SKILL,
    "必须包含这些二级标题：基础信息、求职诉求、职业发展期望、工作经历、能力标签、技能关键词、求职偏好/避雷、兜底关键词、风险/需确认。",
    "画像可以写技能关键词、个人偏好/避雷的描述、兜底关键词；兜底关键词可人工调整。",
    "不要在画像中写每日搜索关键词（下一轮搜索用词），这些由独立关键词模块生成。",
    `目标岗位：${state.target_roles}`,
    `目标城市：${state.target_city}`,
    `薪资：${state.target_salary}`,
    `职业发展期望：${state.career_expectation || "待确认"}`,
    `经历：${state.experience}`,
    `简历（已脱敏）：${sanitizeProfile(state.resume_md || "")}`,
  ].join("\n"));
  const profile = aiProfile?.text && aiProfile.text.length > 40
    ? ensureProfileSections(aiProfile.text, profileLocal)
    : profileLocal;
  const keywordResult = await generateKeywords(db, { ...state, profile_md: profile });
  const finalProfile = replaceFallbackSection(profile, keywordResult.fallbackKeywords);
  state.profile_md = finalProfile;
  state.daily_keywords = keywordResult.keywords;
  appendMessage(db, sessionId, "assistant", `画像信息已齐，生成如下：\n\n${finalProfile}\n\n每日搜索关键词（单独保存，不写入画像）：${keywordResult.keywords.join("、")}`, {
    action: "profile_ready",
    profile_md: finalProfile,
    keywords: keywordResult.keywords,
    fallback_keywords: keywordResult.fallbackKeywords,
    keyword_ai_used: keywordResult.aiUsed,
    keyword_history_used: keywordResult.historyUsed,
    validation: {
      ...validateProfileOutput(finalProfile),
      ...validateKeywordOutput(keywordResult.keywords, keywordResult.fallbackKeywords),
    },
    resume_id: state.resume_id || "",
    ai_used: Boolean(aiProfile),
    suggested: {
      nickname: state.parsed?.name || "新角色",
      profile_md: finalProfile,
      target_roles: state.target_roles,
      target_city: state.target_city,
      target_salary: state.target_salary,
      career_expectation: state.career_expectation || "",
      role_keywords: keywordResult.keywords,
      fallback_keywords: keywordResult.fallbackKeywords,
    },
    steps: [
      "parse_resume",
      "extract_fields",
      aiProfile ? "ai_generate_profile" : "generate_profile",
      keywordResult.aiUsed ? "ai_generate_keywords" : "generate_keywords",
    ],
  });
  updateState(db, sessionId, state);
  return { session: getSession(db, sessionId), reply: { text: "画像已生成", profile_md: finalProfile, keywords: keywordResult.keywords } };
}

function validateProfileOutput(profile) {
  const text = String(profile || "");
  const required = ["## 基础信息", "## 求职诉求", "## 职业发展期望", "## 工作经历", "## 能力标签", "## 技能关键词", "## 求职偏好/避雷", "## 兜底关键词", "## 风险/需确认"];
  const errors = [];
  for (const heading of required) if (!text.includes(heading)) errors.push(`缺少 ${heading}`);
  if (/1[3-9]\d{9}/.test(text) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text)) errors.push("画像包含联系方式");
  if (/##\s*每日搜索关键词/.test(text)) errors.push("画像包含每日搜索关键词");
  return { profile_ok: errors.length === 0, profile_errors: errors };
}

function validateKeywordOutput(keywords, fallback) {
  const recommended = Array.isArray(keywords) ? keywords : [];
  const backups = Array.isArray(fallback) ? fallback : [];
  const errors = [];
  if (recommended.length < 8 || recommended.length > 12) errors.push("推荐关键词数量应为 8-12");
  if (backups.length < 3) errors.push("兜底关键词至少 3 个");
  if (recommended.some((item) => /[省市区县]|K$|^\d+$/.test(String(item)))) errors.push("关键词不应混入城市/薪资/纯数字");
  return { keyword_ok: errors.length === 0, keyword_errors: errors };
}

async function enrichRoleProfile(db, role) {
  const missing = [];
  if (!role.profile_md) missing.push("角色画像");
  if (!role.target_roles) missing.push("目标岗位");
  if (!role.target_city) missing.push("目标城市");
  if (role.salary_min == null || role.salary_max == null) missing.push("期望薪资");
  if (!role.resume_id) missing.push("原始简历");
  const prompt = [
    "请作为角色信息补全助手，严格按下面的画像 Skill 检查这个角色还缺什么。",
    PROFILE_SKILL,
    "只问真正影响匹配和搜索的信息，不要一次问太多；不要编造用户经历。",
    "只输出 JSON：{\"missing\":[\"缺什么\"],\"questions\":[\"要问用户的问题\"],\"suggested_profile_md\":\"在现有画像基础上补全后的完整 Markdown\"}。",
    `角色编号：${role.role_number || ""}`,
    `昵称：${role.nickname || ""}`,
    `目标岗位：${role.target_roles || ""}`,
    `目标城市：${role.target_city || ""}`,
    `薪资：${role.salary_min || ""}-${role.salary_max || ""}K`,
    `现有画像：\n${role.profile_md || ""}`,
  ].join("\n");
  const ai = await askAI(db, prompt);
  if (!ai) {
    return {
      aiUsed: false,
      missing,
      questions: missing.map((item) => `请补充${item}`),
      suggestedProfile: role.profile_md || "",
      reply: missing.length ? `还需要补充：${missing.join("、")}` : "现有信息基本完整，可以确认渠道。",
    };
  }
  let parsed = {};
  try {
    const raw = String(ai.text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(raw);
  } catch {
    return { aiUsed: true, missing, questions: [ai.text], suggestedProfile: role.profile_md || "", reply: ai.text };
  }
  const missingList = Array.isArray(parsed.missing)
    ? parsed.missing
    : (parsed.missing ? [String(parsed.missing)] : missing);
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
    : (parsed.questions ? [String(parsed.questions)] : []);
  const suggested = sanitizeProfile(parsed.suggested_profile_md || role.profile_md || "");
  return {
    aiUsed: true,
    missing: missingList,
    questions,
    suggestedProfile: ensureProfileSections(suggested, role.profile_md || suggested),
    reply: questions.join("\n"),
  };
}

module.exports = {
  createSession,
  listSessions,
  getSession,
  appendMessage,
  updateState,
  runTurn,
  buildProfile,
  sanitizeProfile,
  generateKeywords,
  enrichRoleProfile,
  extractCities,
  extractSalary,
  inferTargetRole,
};
