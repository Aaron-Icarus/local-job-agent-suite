const crypto = require("crypto");
const { nowIso } = require("./jobs_repo");
const { importResume } = require("./resumes_repo");
const { parseResumeMarkdown, resumeToProfileMarkdown } = require("./resume_parser");
const { searchRoleJobs } = require("./scores_repo");
const { getRole } = require("./roles_repo");
const { runWithFallback } = require("./ai_providers");

const KNOWN_CITIES = ["上海", "北京", "深圳", "广州", "杭州", "苏州", "成都", "武汉", "南京", "西安", "重庆"];

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

function buildProfile(state) {
  const parsed = state.parsed || {};
  return [
    `# ${parsed.name || "候选人"} 角色画像`,
    "",
    `## 目标岗位\n${state.target_roles || "-"}`,
    `## 目标城市\n${state.target_city || "-"}`,
    `## 薪资预期\n${state.target_salary || "-"}`,
    `## 相关经历\n${state.experience || parsed.experience_summary || "-"}`,
    `## 技能\n${(parsed.skills || []).join("、") || "-"}`,
    `## 教育\n${parsed.education || "-"}`,
    `## 偏好/避雷\n${state.preferences || "未填写"}`,
    "",
    "> 由本地简历解析 + 角色画像 Skill 生成；请人工确认事实后再启用角色。",
  ].join("\n");
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
  }

  const targetRoles = input.target_roles || extractField(text, ["目标岗位", "求职意向", "期望岗位"]);
  const targetCity = input.target_city || extractField(text, ["目标城市", "城市", "地点"]) || extractCities(text)[0] || "";
  const targetSalary = input.target_salary || extractSalary(text);
  const experience = input.experience || extractExperience(text) || state.parsed?.experience_summary || "";
  if (targetRoles) state.target_roles = targetRoles;
  if (targetCity) state.target_city = targetCity;
  if (targetSalary) state.target_salary = targetSalary;
  if (experience) state.experience = experience;
  if (input.preferences) state.preferences = input.preferences;

  const wantsJobs = /岗位|推荐|搜索|合适|机会/.test(text) && !/生成画像|画像/.test(text);
  if (wantsJobs) {
    const reply = jobSearchReply(db, state);
    appendMessage(db, sessionId, "assistant", reply.text, reply.metadata);
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
    "请根据以下真实信息生成一份角色画像 Markdown，只输出 Markdown，不要编造事实。",
    `目标岗位：${state.target_roles}`,
    `目标城市：${state.target_city}`,
    `薪资：${state.target_salary}`,
    `经历：${state.experience}`,
    `简历：${state.resume_md || ""}`,
  ].join("\n"));
  const profile = aiProfile?.text && aiProfile.text.length > 40 ? aiProfile.text : profileLocal;
  state.profile_md = profile;
  appendMessage(db, sessionId, "assistant", `画像信息已齐，生成如下：\n\n${profile}`, {
    action: "profile_ready",
    profile_md: profile,
    resume_id: state.resume_id || "",
    ai_used: Boolean(aiProfile),
    suggested: {
      nickname: state.parsed?.name || "新角色",
      profile_md: profile,
      target_roles: state.target_roles,
      target_city: state.target_city,
      target_salary: state.target_salary,
    },
    steps: aiProfile
      ? ["parse_resume", "extract_fields", "ai_generate_profile"]
      : ["parse_resume", "extract_fields", "generate_profile"],
  });
  updateState(db, sessionId, state);
  return { session: getSession(db, sessionId), reply: { text: "画像已生成", profile_md: profile } };
}

module.exports = {
  createSession,
  listSessions,
  getSession,
  appendMessage,
  updateState,
  runTurn,
  buildProfile,
  extractCities,
  extractSalary,
};
