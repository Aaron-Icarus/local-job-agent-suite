const PROFILE_TRIGGER = /生成画像|更新画像|重做画像|调整画像|修改画像|完善画像|画像更新|生成角色画像|重新生成画像/;
const PROFILE_WORD = /画像|简历|角色/;
const JOB_SEARCH = /找岗位|查岗位|推荐岗位|搜索岗位|有哪些岗位|有什么岗位|什么岗位|岗位机会|职位推荐|查职位|看看岗位|适合的岗位|匹配的岗位|找.*岗位|搜.*岗位|查.*岗位/;
const JOB_DETAIL = /JD|jd|岗位详情|职位详情|评分|日报/;
const JOB_CODE = /[A-Z]\d{3,4}/;
const GREETING = /打招呼|招呼话术|开场白|写招呼|生成招呼|打个招呼/;
const PREFERENCE = /职业规划|职业方向|主要看|重点看|聚焦|优先看|不考虑|不想|不要|排除|规避|不是考虑|避雷|方向/;
const TARGET_FIELD = /目标岗位|求职意向|期望岗位|目标城市|期望薪资/;
const FIELD_UPDATE = /(城市|薪资|岗位|求职意向|工作经历|相关经历)\s*[:：]/;
const CLARIFY = /^(帮我看看|看看|怎么办|然后呢|这个呢)[？?。.!！]*$/;

function hasResume(state, input) {
  return Boolean(input.resume_md || state.resume_md);
}

function classifyIntent({ text = "", input = {}, state = {}, targetRoles = "" } = {}) {
  const value = String(text || "").trim();
  const resume = hasResume(state, input);
  const hasProfile = Boolean(state.profile_md);
  const slots = {
    resume,
    hasProfile,
    targetRoles: Boolean(targetRoles || state.target_roles),
    targetCity: Boolean(state.target_city || input.target_city),
    targetSalary: Boolean(state.target_salary || input.target_salary),
    preference: PREFERENCE.test(value),
    explicitProfile: PROFILE_TRIGGER.test(value),
    explicitJobs: JOB_SEARCH.test(value),
  };
  const result = (name, confidence, reason) => ({ name, confidence, reason, slots });

  if (GREETING.test(value)) return result("greeting", 0.98, "打招呼/开场白");
  if (JOB_DETAIL.test(value) && JOB_CODE.test(value)) return result("job_detail", 0.98, "岗位编号+详情");
  if (PROFILE_TRIGGER.test(value)) {
    return result(hasProfile || slots.preference ? "profile_update" : "profile_create", 0.98, "明确的画像指令");
  }
  if (PREFERENCE.test(value) && resume && (PROFILE_WORD.test(value) || hasProfile || slots.preference)) {
    return result("profile_update", 0.9, "简历会话中的职业偏好/避雷修正");
  }
  if (JOB_SEARCH.test(value) && !TARGET_FIELD.test(value)) {
    return result("job_search", 0.9, "明确的岗位搜索");
  }
  if (input.resume_md) return result(hasProfile ? "profile_update" : "profile_create", 0.9, "本轮上传简历");
  if (PROFILE_WORD.test(value) && resume) return result(hasProfile ? "profile_update" : "profile_create", 0.75, "画像/简历上下文");
  if (CLARIFY.test(value)) return result("clarify", 0.6, "需要澄清用户意图");
  if (TARGET_FIELD.test(value) || FIELD_UPDATE.test(value) || targetRoles) {
    return result(resume ? "profile_update" : "profile_create", 0.75, "目标岗位/城市/薪资字段");
  }
  if (resume && PREFERENCE.test(value)) return result("profile_update", 0.75, "简历会话中的偏好");
  return result("chat", 0.55, "普通对话");
}

module.exports = { classifyIntent };
