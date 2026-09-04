const { runAiTask } = require("../core/ai_router");

function clamp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function jsonArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 6) : null;
}

function compactJob(row, index) {
  return {
    index,
    platform: row.platform || "",
    company: row.company || "",
    job_title: row.job_title || "",
    salary: row.salary || "",
    location: row.district || row.city || "",
    job_text: String(row.job_description || row.page_card_text || "").slice(0, 2500),
    collection_status: row.collection_status || "",
  };
}

function fallbackRows(rows, reason, status = "fallback_rules") {
  return rows.map((row) => ({ ...row, evaluation_version: "fit_eval_v3_ai_router", ai_evaluation_status: status, ai_evaluation_provider: "", ai_evaluation_model: "", ai_evaluation_reason: reason }));
}

async function refineEvaluations(records, baselineRows, profileRules) {
  const maxRows = Math.max(1, Number(process.env.AI_FIT_EVALUATION_MAX_ROWS || 40));
  const selected = records.slice(0, maxRows);
  const ai = await runAiTask({
    purpose: "fit_evaluation",
    options: { max_output_tokens: Math.max(1200, selected.length * 100) },
    instructions: "你是求职岗位匹配评估助手。根据候选人规则、岗位文本和确定性基线评分，复核整体匹配与投递建议。只返回 JSON：{\"evaluations\":[{\"index\":0,\"overall_fit_score\":0-100,\"application_success_score\":0-100,\"focus_level\":\"重点关注|重点关注-需确认详情|可关注|低优先|暂不考虑\",\"application_recommendation\":\"...\",\"match_reasons\":[\"...\"],\"risk_reasons\":[\"...\"],\"evaluation_summary\":\"...\"}]}。不得虚构候选人经历或岗位事实；薪资、地点、岗位详情可信度等硬约束必须尊重基线评分。",
    input: { profile_rules: profileRules, jobs: selected.map(compactJob), deterministic_baseline: baselineRows.slice(0, maxRows).map((row, index) => ({ index, overall_fit_score: row.overall_fit_score, application_success_score: row.application_success_score, focus_level: row.focus_level, application_recommendation: row.application_recommendation, match_reasons: JSON.parse(row.match_reasons_json || "[]"), risk_reasons: JSON.parse(row.risk_reasons_json || "[]") })) },
  });
  if (!ai.ok) return fallbackRows(baselineRows, ai.reason || "AI 未返回结果");
  let items = [];
  try { items = JSON.parse(ai.text.replace(/^```json\s*|\s*```$/g, "")).evaluations || []; } catch { return fallbackRows(baselineRows, "AI 返回不是有效 JSON"); }
  const byIndex = new Map(items.map((item) => [Number(item.index), item]));
  return baselineRows.map((baseline, index) => {
    const item = byIndex.get(index);
    if (!item || index >= maxRows) return { ...baseline, evaluation_version: "fit_eval_v3_ai_router", ai_evaluation_status: index >= maxRows ? "rules_not_requested" : "fallback_rules", ai_evaluation_provider: "", ai_evaluation_model: "", ai_evaluation_reason: index >= maxRows ? `超过本轮 AI 批量上限 ${maxRows}` : "AI 未返回该岗位结果" };
    const overall = clamp(item.overall_fit_score);
    const success = clamp(item.application_success_score);
    return {
      ...baseline,
      evaluation_version: "fit_eval_v3_ai_router",
      overall_fit_score: overall == null ? baseline.overall_fit_score : overall,
      application_success_score: success == null ? baseline.application_success_score : success,
      focus_level: item.focus_level || baseline.focus_level,
      application_recommendation: String(item.application_recommendation || baseline.application_recommendation).slice(0, 160),
      evaluation_summary: String(item.evaluation_summary || baseline.evaluation_summary).slice(0, 500),
      match_reasons_json: JSON.stringify(jsonArray(item.match_reasons) || JSON.parse(baseline.match_reasons_json || "[]")),
      risk_reasons_json: JSON.stringify(jsonArray(item.risk_reasons) || JSON.parse(baseline.risk_reasons_json || "[]")),
      ai_evaluation_status: "success",
      ai_evaluation_provider: ai.provider,
      ai_evaluation_model: ai.model,
      ai_evaluation_reason: ai.fallback ? "步骤配置失败后使用默认 AI 配置" : "使用步骤配置或默认 AI 配置",
    };
  });
}

module.exports = { refineEvaluations };
