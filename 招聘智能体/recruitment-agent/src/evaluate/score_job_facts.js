const { shanghaiDateKey } = require("../core/time_utils");

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.round(Math.max(min, Math.min(max, number)));
}

function textOf(row) {
  return [
    row.job_title,
    row.company,
    row.company_industry,
    row.tags,
    row.skills,
    row.job_description,
    row.page_card_text,
  ].map((value) => (Array.isArray(value) ? value.join(" ") : String(value || ""))).join(" ");
}

function titleOf(row) {
  return String(row.job_title || "");
}

function fact(row, key) {
  if (row && row.facts && row.facts[key] !== undefined) return row.facts[key];
  return row ? row[key] : undefined;
}

function optionalNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matches(text, word) {
  return String(text || "").toLowerCase().includes(String(word || "").toLowerCase());
}

function matchingWords(text, words) {
  return [...new Set((words || []).filter((word) => word && matches(text, word)))];
}

function keywordScore(text, words, maxHits = 3) {
  const hits = matchingWords(text, words).length;
  if (!hits) return 0;
  return clamp((hits / Math.max(1, maxHits)) * 100);
}

function daysBetween(dateText) {
  if (!dateText) return null;
  const date = new Date(`${String(dateText).slice(0, 10)}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(`${shanghaiDateKey()}T00:00:00+08:00`);
  return Math.round((today - date) / 86400000);
}

function salaryScore(row, candidate, rules, hard) {
  const min = optionalNumber(fact(row, "salary_min_k"));
  const max = optionalNumber(fact(row, "salary_max_k"));
  const targetMin = optionalNumber(candidate.target_salary_k?.min) ?? 0;
  const targetMax = optionalNumber(candidate.target_salary_k?.max) ?? targetMin;
  const floor = optionalNumber(candidate.target_salary_k?.floor) ?? targetMin;
  const config = rules.scoring || {};
  if (min === null || max === null) {
    const action = String(rules.hard?.unknown_salary_action || "need_confirm").toLowerCase();
    if (action === "fail") hard.fail.push("薪资未解析，按配置视为不合格");
    else if (action !== "pass") hard.needConfirm.push("薪资未解析，需人工确认是否达到底线");
    return config.salary_unknown_score ?? 55;
  }
  if (max < floor) {
    hard.fail.push(`薪资上限${max}K低于底线${floor}K`);
    return config.salary_below_floor_score ?? 10;
  }
  if (min <= targetMin && max >= targetMax) return config.salary_cover_score ?? 100;
  if (min <= targetMax && max >= targetMin) return config.salary_overlap_score ?? 85;
  if (min > targetMax) return config.salary_above_target_score ?? 40;
  return config.salary_below_floor_score ?? 10;
}

function locationScore(row, candidate, rules, hard) {
  const city = String(fact(row, "city") || "");
  const district = String(fact(row, "district") || "");
  const address = String(fact(row, "address") || "");
  const businessArea = String(fact(row, "business_area") || "");
  const text = `${city} ${district} ${address} ${businessArea}`;
  const config = rules.scoring || {};
  const cities = candidate.cities || [];
  if (candidate.lower_priority_districts?.some((item) => item && text.includes(item))) {
    return config.location_lower_priority_score ?? 72;
  }
  if (cities.some((item) => item && text.includes(item))) return config.location_target_score ?? 95;
  if (candidate.accept_remote && /远程|remote/i.test(text)) return config.location_target_score ?? 95;
  if (!text.trim()) {
    const action = String(rules.hard?.unknown_city_action || "need_confirm").toLowerCase();
    if (action === "fail") hard.fail.push("地点信息缺失，按配置视为不合格");
    else if (action !== "pass") hard.needConfirm.push("地点信息缺失，需确认是否可接受");
    return config.location_unknown_score ?? 65;
  }
  hard.fail.push(`工作地点不在目标城市（${cities.join("/") || "未配置"}）`);
  return config.location_other_score ?? 30;
}

function activityScore(row, candidate, rules) {
  const config = rules.scoring || {};
  const activeText = String(fact(row, "boss_active_text") || fact(row, "recruiter_active_text") || "");
  const online = fact(row, "boss_online") === true || fact(row, "boss_online") === "true";
  if (online || /当前在线|刚刚在线|今日活跃|今天活跃|刚刚活跃/.test(activeText)) return config.activity_online_score ?? 95;
  let days = optionalNumber(fact(row, "active_days"));
  if (days === null) days = daysBetween(fact(row, "latest_active_date"));
  if (days === null) return config.activity_unknown_score ?? 58;
  const high = Number(candidate.activity_rules?.activeWithinDaysHigh || 7);
  const low = Number(candidate.activity_rules?.activeWithinDaysLow || 14);
  const ignore = Number(candidate.activity_rules?.inactiveOverDaysIgnore || 30);
  if (days <= high) return 90;
  if (days <= low) return 55;
  if (days <= ignore) return 30;
  return 10;
}

function confidenceScore(row, rules) {
  const config = rules.scoring || {};
  const status = String(fact(row, "collection_status") || fact(row, "detail_status") || "");
  const length = String(fact(row, "job_description") || "").trim().length;
  if (status !== "ok") return config.confidence_missing_score ?? 55;
  if (length >= Number(config.confidence_full_jd_chars || 150)) return config.confidence_full_jd_score ?? 100;
  if (length >= Number(config.confidence_short_jd_chars || 60)) return config.confidence_short_jd_score ?? 75;
  return config.confidence_missing_score ?? 55;
}

function evaluateHard(row, candidate, rules) {
  const title = titleOf(row);
  const text = textOf(row);
  const hard = { status: "pass", fail: [], needConfirm: [] };
  const rulesHard = rules.hard || {};

  if (rulesHard.reject_sales_title !== false && (rules.keywords?.sales || []).some((word) => matches(title, word))) {
    hard.fail.push("标题属于销售/商务/获客方向");
  }
  if (rulesHard.reject_intern_title !== false && (rules.keywords?.intern || []).some((word) => matches(title, word))) {
    hard.fail.push("标题属于实习/应届/管培方向");
  }
  if ((candidate.avoid_title_keywords || []).some((word) => matches(title, word))) {
    hard.fail.push("标题命中候选人避雷词");
  }
  const avoidJd = (candidate.avoid_jd_keywords || []).filter((word) => matches(text, word));
  if (avoidJd.length) {
    if (rulesHard.reject_avoid_jd === true) hard.fail.push(`岗位文本命中避雷词：${avoidJd.slice(0, 3).join("、")}`);
    else hard.needConfirm.push(`岗位文本命中避雷词：${avoidJd.slice(0, 3).join("、")}`);
  }

  const targetRoles = candidate.target_roles || [];
  const roleInTitle = targetRoles.some((word) => matches(title, word));
  const roleWords = [...targetRoles, ...(rules.keywords?.role || [])];
  const roleInText = roleWords.some((word) => matches(text, word));
  const techInTitle = (rules.keywords?.tech || []).some((word) => matches(title, word));
  const deliveryInTitle = (rules.keywords?.delivery || []).some((word) => matches(title, word));
  if (rulesHard.reject_pure_tech !== false && candidate.allow_pure_tech !== true && techInTitle && !roleInTitle && !deliveryInTitle) {
    hard.fail.push("标题像纯技术岗，且没有管理/交付/产品成分");
  }

  const salary = salaryScore(row, candidate, rules, hard);
  const location = locationScore(row, candidate, rules, hard);
  if (hard.fail.length) hard.status = "fail";
  else if (hard.needConfirm.length) hard.status = "need_confirm";
  return { hard, salary, location, roleSignal: roleInText || roleInTitle };
}

function deriveFocus(overall, success, hard, rules) {
  const thresholds = rules.thresholds || {};
  if (hard.status === "fail") {
    return {
      focus_level: "暂不考虑",
      recommendation: "不建议投递，除非人工确认岗位信息与预期明显不同",
      action: "跳过",
    };
  }
  if (hard.status === "need_confirm") {
    return {
      focus_level: "需确认",
      recommendation: "先补薪资/地点/详情或人工确认，再决定是否投递",
      action: "补信息",
    };
  }
  if (overall >= (thresholds.focus_high ?? 78) && success >= (thresholds.success_high ?? 68)) {
    return { focus_level: "重点关注", recommendation: "优先投递或优先沟通", action: "优先沟通" };
  }
  if (overall >= (thresholds.focus_medium ?? 66)) {
    return { focus_level: "可关注", recommendation: "可加入备选，人工确认职责后投递", action: "人工确认" };
  }
  if (overall >= (thresholds.focus_low ?? 50)) {
    return { focus_level: "低优先", recommendation: "仅在详情和薪资更合适时再考虑", action: "暂缓" };
  }
  return { focus_level: "暂不考虑", recommendation: "当前规则下不建议投递", action: "跳过" };
}

function scoreJob(row, candidate, rules, options = {}) {
  const text = textOf(row);
  const title = titleOf(row);
  const hardResult = evaluateHard(row, candidate, rules);
  const { hard } = hardResult;

  const roleTargetHits = (candidate.target_roles || []).filter((word) => matches(title, word));
  const roleWordHits = (rules.keywords?.role || []).filter((word) => matches(title, word));
  const roleTextHits = [...(candidate.target_roles || []), ...(rules.keywords?.role || [])].filter((word) => matches(text, word));
  const role = clamp(Math.max(
    roleTargetHits.length ? 100 : 0,
    roleWordHits.length ? 88 : 0,
    roleTextHits.length ? 65 : 0,
    hardResult.roleSignal ? 60 : 25,
  ));
  const experience = clamp(
    keywordScore(text, [...(candidate.strengths || []), ...(candidate.target_roles || [])], 4) * 0.8 +
    keywordScore(text, (rules.keywords?.tech || []), 4) * 0.2,
  );
  const ai = keywordScore(text, rules.keywords?.ai || [], 3);
  const delivery = keywordScore(text, rules.keywords?.delivery || [], 4);
  const product = keywordScore(text, rules.keywords?.product || [], 3);
  const domain = keywordScore(text, [...(rules.keywords?.domain || []), ...(candidate.preferred_industries || [])], 3);
  const salary = hardResult.salary;
  const location = hardResult.location;
  const activity = activityScore(row, candidate, rules);
  const confidence = confidenceScore(row, rules);
  const weights = rules.weight_profiles?.[candidate.role_family] || rules.weights || {};
  const overall = clamp(
    role * (weights.role ?? 0.2) +
    experience * (weights.experience ?? 0.17) +
    ai * (weights.ai ?? 0.12) +
    delivery * (weights.delivery ?? 0.14) +
    product * (weights.product ?? 0.1) +
    domain * (weights.domain ?? 0.09) +
    salary * (weights.salary ?? 0.08) +
    location * (weights.location ?? 0.04) +
    activity * (weights.activity ?? 0.03) +
    confidence * (weights.confidence ?? 0.03),
  );
  const success = clamp(
    role * 0.25 + experience * 0.2 + salary * 0.15 + delivery * 0.15 +
    activity * 0.1 + location * 0.1 + confidence * 0.05,
  );
  const focus = deriveFocus(overall, success, hard, rules);

  const reasons = [];
  const risks = [];
  if (role >= 80) reasons.push("岗位标题/职责与目标角色高度相关");
  else if (role >= 60) reasons.push("岗位职责与目标角色有交集");
  if (experience >= 60) reasons.push("技能与经历关键词有较多重合");
  if (ai >= 60) reasons.push("岗位涉及 AI/智能体/大模型相关能力");
  if (delivery >= 60) reasons.push("岗位包含项目交付/客户协同/需求推进职责");
  if (product >= 60) reasons.push("岗位包含产品/方案/需求设计职责");
  if (domain >= 60) reasons.push("行业/领域与过往经历有交集");
  if (salary >= 85) reasons.push("薪资覆盖目标区间");
  if (location >= 90) reasons.push(`地点符合${(candidate.cities || []).join("/")}偏好`);
  if (activity >= 90) reasons.push("招聘方近期活跃");
  if (confidence >= 90) reasons.push("具备完整岗位详情，信息可信");

  for (const item of hard.fail) risks.push(item);
  for (const item of hard.needConfirm) risks.push(item);
  if (salary > 0 && salary <= 45) risks.push("薪资低于目标或高于目标上限，需确认是否值得");
  if (location > 0 && location < 70) risks.push("地点需要确认通勤是否可接受");
  if (activity > 0 && activity <= 40) risks.push("招聘方活跃度偏低");
  if (confidence < 80) risks.push("岗位详情不完整，判断依据有限");
  if (experience < 40) risks.push("简历关键词与岗位要求重合度不高");

  const score = {
    rule_version: options.ruleVersion || "",
    candidate_version: options.candidateVersion || "",
    scored_at: new Date().toISOString(),
    hard: {
      status: hard.status,
      failures: [...new Set(hard.fail)],
      need_confirm: [...new Set(hard.needConfirm)],
    },
    soft: {
      role,
      experience,
      ai,
      delivery,
      product,
      domain,
      salary,
      location,
      activity,
      confidence,
    },
    overall,
    success,
    focus_level: focus.focus_level,
    recommendation: focus.recommendation,
    action: focus.action,
    reasons: [...new Set(reasons)].slice(0, 6),
    risks: [...new Set(risks)].slice(0, 6),
    ai: { used: false, status: "not_requested", provider: "", model: "", delta: 0, reasons: [], risks: [] },
  };
  const summary = [
    `${title || "未知岗位"} / ${row.company || "未知公司"}`,
    `综合${overall}，成功概率${success}`,
    score.reasons.length ? `优势：${score.reasons.slice(0, 3).join("、")}` : "",
    score.risks.length ? `风险：${score.risks.slice(0, 3).join("、")}` : "",
  ].filter(Boolean).join("；");

  return {
    ...row,
    evaluation_date: options.dateKey || shanghaiDateKey(),
    evaluation_version: "fit_eval_v4_facts",
    rule_version: score.rule_version,
    role_type_fit_score: role,
    nontechnical_fit_score: role,
    ai_agent_fit_score: ai,
    project_delivery_fit_score: delivery,
    product_fit_score: product,
    domain_experience_fit_score: domain,
    salary_fit_score: salary,
    location_fit_score: location,
    activity_fit_score: activity,
    detail_confidence_score: confidence,
    overall_fit_score: overall,
    application_success_score: success,
    focus_level: focus.focus_level,
    application_recommendation: focus.recommendation,
    application_success_band: success >= 75 ? "较高" : success >= 62 ? "中高" : success >= 48 ? "中" : "偏低",
    evaluation_summary: summary,
    match_reasons_json: JSON.stringify(score.reasons),
    risk_reasons_json: JSON.stringify(score.risks),
    score,
  };
}

module.exports = {
  scoreJob,
  deriveFocus,
  evaluateHard,
  keywordScore,
  matchingWords,
  optionalNumber,
  clamp,
  fact,
};
