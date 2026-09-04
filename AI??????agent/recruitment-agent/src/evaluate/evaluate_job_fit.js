const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { shanghaiDateKey } = require("../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../core/field_dictionary");
const { loadEnv } = require("../core/load_env");
const { refineEvaluations } = require("./ai_fit_refiner");

loadEnv();

const processDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(processDir, "outputs");
const profileRulesPath = path.join(processDir, "config", "profile_rules.json");
const profileRules = JSON.parse(fs.readFileSync(profileRulesPath, "utf8"));
const ruleVersion = crypto.createHash("sha256").update(JSON.stringify(profileRules)).digest("hex").slice(0, 12);
fs.mkdirSync(outputsDir, { recursive: true });

function latestFile(pattern) {
  const files = fs
    .readdirSync(outputsDir)
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, full: path.join(outputsDir, name), mtime: fs.statSync(path.join(outputsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files[0]) throw new Error(`No matching input file found in ${outputsDir}`);
  return files[0].full;
}

const inputPath =
  process.argv[2] ||
  latestFile(/^boss_stage2_screened_.*\.json$/);
const evaluationDate = process.argv[3] || process.env.EVALUATION_DATE || shanghaiDateKey();
const outputPrefix = process.argv[4] || process.env.EVAL_OUTPUT_PREFIX || "boss_stage3_fit_evaluated";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outJson = path.join(outputsDir, `${outputPrefix}_${stamp}.json`);
const outCsv = path.join(outputsDir, `${outputPrefix}_${stamp}.csv`);
const outSummary = path.join(outputsDir, `${outputPrefix}_summary_${stamp}.md`);

function val(v) {
  if (Array.isArray(v)) return v.join("; ");
  if (v == null) return "";
  return String(v);
}

function csvCell(v) {
  return `"${val(v).replace(/"/g, '""')}"`;
}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function has(text, regex) {
  return regex.test(text || "");
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function scoreSalary(row, reasons, risks) {
  const targetMin = Number(profileRules.targetSalaryK?.min ?? 20);
  const targetMax = Number(profileRules.targetSalaryK?.max ?? 25);
  const min = Number(row.salary_min_k);
  const max = Number(row.salary_max_k);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    risks.push("薪资结构未解析，需人工确认");
    return 55;
  }
  if (max < targetMin) {
    risks.push(`薪资上限低于${targetMin}K目标下限`);
    return 10;
  }
  if (min > targetMax) {
    risks.push(`薪资下限高于${targetMax}K目标上限，可能门槛或竞争偏高`);
    return min >= 35 ? 20 : 38;
  }
  if (min <= targetMin && max >= targetMax) {
    reasons.push(`薪资完整覆盖${targetMin}K-${targetMax}K目标区间`);
    return 100;
  }
  if (min <= targetMax && max >= targetMin) {
    reasons.push(`薪资与${targetMin}K-${targetMax}K目标区间有交集`);
    return 88;
  }
  return 55;
}

function scoreLocation(row, reasons, risks) {
  const city = val(row.city);
  const district = val(row.district);
  const address = val(row.address);
  const text = `${city} ${district} ${address}`;
  const lowerPriorityDistricts = profileRules.lowerPriorityDistricts || [];
  if (lowerPriorityDistricts.some((district) => district && text.includes(district))) {
    risks.push(`地点在${lowerPriorityDistricts.join("/")}，按偏好降权但仍可考虑`);
    return 72;
  }
  const targetLocation = profileRules.targetLocation || "上海";
  if (text.includes(targetLocation)) {
    reasons.push(`地点符合${targetLocation}偏好`);
    return 95;
  }
  if (!text.trim()) {
    risks.push("地点信息不完整");
    return 65;
  }
  risks.push("地点可能不在上海或需要确认");
  return 35;
}

function scoreActivity(row, reasons, risks) {
  const highDays = Number(profileRules.activityRules?.activeWithinDaysHigh ?? 7);
  const lowDays = Number(profileRules.activityRules?.activeWithinDaysLow ?? 14);
  const ignoreDays = Number(profileRules.activityRules?.inactiveOverDaysIgnore ?? 30);
  const activeText = val(row.boss_active_text || row.recruiter_active_text || row.active_text);
  const activeDays = Number(row.active_days);
  const online = row.boss_online === true || row.boss_online === "true";
  if (online || /在线|刚刚|今天|今日|本周/.test(activeText)) {
    reasons.push("发布人近期在线或活跃");
    return 95;
  }
  if (Number.isFinite(activeDays)) {
    if (activeDays <= highDays) {
      reasons.push("发布人一周内活跃");
      return 90;
    }
    if (activeDays <= lowDays) {
      risks.push("发布人活跃时间超过一周");
      return 55;
    }
    if (activeDays <= ignoreDays) {
      risks.push("发布人超过两周不活跃");
      return 30;
    }
    risks.push("发布人超过一个月不活跃");
    return 10;
  }
  risks.push("活跃时间不明确");
  return 58;
}

function scoreDetailConfidence(row, reasons, risks) {
  if (row.collection_status === "ok") {
    reasons.push("接口结构化详情完整");
    return 100;
  }
  if (row.collection_status === "page_text_fallback") {
    risks.push("仅页面文本兜底，需人工打开确认右侧详情");
    return 55;
  }
  if (row.collection_status === "detail_not_captured") {
    risks.push("详情监听超时，当前只有列表候选");
    return 25;
  }
  if (row.collection_status === "not_found_in_ui") {
    risks.push("页面未定位到可点击卡片，需要单条补采");
    return 18;
  }
  risks.push(`采集状态需确认：${row.collection_status || "未知"}`);
  return 35;
}

function evaluate(row) {
  const reasons = [];
  const risks = [];
  const title = val(row.job_title);
  const company = val(row.company);
  const industry = val(row.company_industry);
  const skills = val(row.skills);
  const status = val(row.collection_status);
  const desc = status === "ok" ? val(row.job_description) : val(row.page_card_text);
  const text = `${title} ${company} ${industry} ${skills} ${desc} ${val(row.tags)}`;
  const strategyText = `${row.search_strategy_type || ""} ${row.keyword || ""} ${row.used_search_keyword_groups_json || ""}`;

  let roleScore = 30;
  if (has(title, /项目经理|项目管理|项目负责人|交付经理|项目交付|PMO|解决方案经理|产品经理|产品负责人|产品专家|需求/)) {
    roleScore = 88;
    reasons.push("岗位标题属于项目/产品/交付/PMO/解决方案方向");
  }
  if (has(title, /销售|商务|BD|客户经理|渠道|获客|课程销售/)) {
    roleScore -= 55;
    risks.push("标题偏销售/商务/获客");
  }
  if (has(title, /实习|应届|管培/)) {
    roleScore -= 35;
    risks.push("岗位偏实习/应届，和当前资历不匹配");
  }

  let nonTechScore = 82;
  if (has(title, /开发|研发|算法|工程师|测试|测开|运维|技师|架构|技术专家|技术负责人|Java|Python|前端|后端|CTO/i)) {
    nonTechScore = has(title, /项目经理|产品经理|PMO|交付|解决方案|需求/) ? 55 : 20;
    risks.push("标题含技术岗信号，需确认是否为非技术管理岗位");
  }
  if (has(title, /销售|商务|BD|获客/)) nonTechScore = Math.min(nonTechScore, 25);

  let aiScore = 18;
  if (has(text, /AI|人工智能|智能体|Agent|大模型|AIGC|RAG|知识库|LLM|AGI|多模态|AI平台|智能问答/i)) {
    aiScore = 86;
    reasons.push("存在AI/智能体/大模型相关信号");
  }
  if (has(title, /智能体|Agent|大模型|AIGC|AI|人工智能|AI平台/i)) aiScore = Math.max(aiScore, 94);
  if (has(strategyText, /AI|人工智能|智能体|Agent|大模型|AIGC|RAG|知识库|私有化/i)) {
    aiScore = Math.max(aiScore, 52);
    risks.push("AI相关性主要来自搜索词，需确认岗位自身描述");
  }

  let deliveryScore = 35;
  if (has(text, /交付|实施|项目管理|项目经理|项目负责人|UAT|验收|私有化|客户|ToB|B端|解决方案|需求|产研|跨部门|上线|部署/)) {
    deliveryScore = 86;
    reasons.push("与项目交付/实施/客户协同经验相关");
  }
  if (has(text, /私有化|UAT|验收|部署|交付经理|项目交付|企业智能方案/)) deliveryScore = Math.max(deliveryScore, 94);

  let productScore = 42;
  if (has(text, /产品经理|产品负责人|产品专家|需求分析|方案设计|原型|MVP|POC|Workflow|Prompt|RAG|知识库|智能体平台/)) {
    productScore = 78;
    reasons.push("存在产品/需求/方案设计相关职责信号");
  }
  if (has(title, /产品经理|产品负责人|产品专家/)) productScore = Math.max(productScore, 88);

  let domainScore = 35;
  if (has(text, /金融|银行|保险|证券|医疗|医院|医美|能源|智能座舱|自动驾驶|车联网|机器人|具身|企业服务|数据治理|算力|GPU|私有化|ToB|B端/)) {
    domainScore = 78;
    reasons.push("行业/场景与既有AI交付或咨询背景有交集");
  }
  if (has(text, /金融|医疗|智能体|私有化|企业服务|大模型|车联网|智能座舱/)) domainScore = Math.max(domainScore, 88);

  const salaryScore = scoreSalary(row, reasons, risks);
  const locationScore = scoreLocation(row, reasons, risks);
  const activityScore = scoreActivity(row, reasons, risks);
  const confidenceScore = scoreDetailConfidence(row, reasons, risks);

  const overall = clamp(
    roleScore * 0.17 +
      nonTechScore * 0.13 +
      aiScore * 0.16 +
      deliveryScore * 0.16 +
      productScore * 0.1 +
      domainScore * 0.1 +
      salaryScore * 0.1 +
      locationScore * 0.04 +
      activityScore * 0.02 +
      confidenceScore * 0.02
  );

  let success = clamp(
    roleScore * 0.18 +
      nonTechScore * 0.15 +
      deliveryScore * 0.18 +
      productScore * 0.09 +
      domainScore * 0.12 +
      salaryScore * 0.16 +
      locationScore * 0.05 +
      activityScore * 0.04 +
      confidenceScore * 0.03
  );

  if (has(title, /销售|商务|获客|实习|应届|开发|算法|测试|运维|技师/) && !has(title, /项目经理|产品经理|交付|PMO|解决方案/)) {
    success = Math.min(success, 38);
  }
  if (confidenceScore < 50) success = Math.min(success, 45);

  let focusLevel = "低优先";
  let recommendation = "暂不建议主动投递";
  if (overall >= 78 && success >= 68 && nonTechScore >= 55 && salaryScore >= 55 && confidenceScore >= 50) {
    focusLevel = confidenceScore >= 80 ? "重点关注" : "重点关注-需确认详情";
    recommendation = confidenceScore >= 80 ? "优先投递/优先沟通" : "先人工打开确认详情，再优先投递";
  } else if (overall >= 65 && success >= 55 && salaryScore >= 45) {
    focusLevel = "可关注";
    recommendation = "可加入备选，人工确认职责和薪资后投递";
  } else if (overall >= 50) {
    focusLevel = "低优先";
    recommendation = "仅在岗位详情确认较好时再考虑";
  }
  if (salaryScore <= 20 || nonTechScore <= 25 || roleScore <= 30) {
    focusLevel = "暂不考虑";
    recommendation = "不建议投递，除非人工确认职责与预期明显不同";
  }

  const probabilityBand =
    success >= 75 ? "较高" : success >= 62 ? "中高" : success >= 48 ? "中" : success >= 35 ? "偏低" : "低";

  const summaryBits = [];
  summaryBits.push(`${title || "未知岗位"} / ${company || "未知公司"}`);
  summaryBits.push(`综合${overall}，成功概率${success}(${probabilityBand})`);
  if (reasons[0]) summaryBits.push(`优势：${unique(reasons).slice(0, 3).join("、")}`);
  if (risks[0]) summaryBits.push(`风险：${unique(risks).slice(0, 3).join("、")}`);

  return {
    evaluation_date: evaluationDate,
    evaluation_version: "fit_eval_v2_profile_rules",
    rule_version: ruleVersion,
    evaluation_basis: row.collection_status === "ok" ? "接口结构化详情" : row.collection_status === "page_text_fallback" ? "页面文本兜底+列表字段" : "列表字段为主",
    role_type_fit_score: clamp(roleScore),
    nontechnical_fit_score: clamp(nonTechScore),
    ai_agent_fit_score: clamp(aiScore),
    project_delivery_fit_score: clamp(deliveryScore),
    product_fit_score: clamp(productScore),
    domain_experience_fit_score: clamp(domainScore),
    salary_fit_score: clamp(salaryScore),
    location_fit_score: clamp(locationScore),
    activity_fit_score: clamp(activityScore),
    detail_confidence_score: clamp(confidenceScore),
    overall_fit_score: overall,
    application_success_score: success,
    application_success_band: probabilityBand,
    focus_level: focusLevel,
    application_recommendation: recommendation,
    evaluation_summary: summaryBits.join("；"),
    match_reasons_json: JSON.stringify(unique(reasons)),
    risk_reasons_json: JSON.stringify(unique(risks)),
    reevaluation_required: row.collection_status === "ok" ? "岗位更新或活跃时间变化时重评" : "需要补采/人工确认详情后重评",
  };
}

async function main() {
const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const records = payload.records || [];
const deterministic = records.map((row) => ({ ...row, ...evaluate(row) }));
const evaluated = await refineEvaluations(records, deterministic, profileRules);

const existingHeaders = [];
for (const row of records) {
  for (const key of Object.keys(row)) {
    if (!existingHeaders.includes(key)) existingHeaders.push(key);
  }
}
const evalHeaders = [
  "platform",
  "evaluation_date",
  "evaluation_version",
  "evaluation_basis",
  "role_type_fit_score",
  "nontechnical_fit_score",
  "ai_agent_fit_score",
  "project_delivery_fit_score",
  "product_fit_score",
  "domain_experience_fit_score",
  "salary_fit_score",
  "location_fit_score",
  "activity_fit_score",
  "detail_confidence_score",
  "overall_fit_score",
  "application_success_score",
  "application_success_band",
  "focus_level",
  "application_recommendation",
  "evaluation_summary",
  "match_reasons_json",
  "risk_reasons_json",
  "ai_evaluation_status",
  "ai_evaluation_provider",
  "ai_evaluation_model",
  "ai_evaluation_reason",
  "reevaluation_required",
];
const headers = [...existingHeaders, ...evalHeaders.filter((key) => !existingHeaders.includes(key))];
const zh = {
  ...fieldZh,
  evaluation_date: "评价日期",
  evaluation_version: "评价版本",
  evaluation_basis: "评价依据",
  role_type_fit_score: "岗位类型适配分",
  nontechnical_fit_score: "非技术岗适配分",
  ai_agent_fit_score: "AI/智能体适配分",
  project_delivery_fit_score: "项目交付适配分",
  product_fit_score: "产品能力适配分",
  domain_experience_fit_score: "行业经历适配分",
  salary_fit_score: "薪酬适配分",
  location_fit_score: "地点适配分",
  activity_fit_score: "活跃度适配分",
  detail_confidence_score: "详情可信度分",
  overall_fit_score: "综合适配分",
  application_success_score: "投递成功概率分",
  application_success_band: "投递成功概率等级",
  focus_level: "关注等级",
  application_recommendation: "投递建议",
  evaluation_summary: "评价总结",
  match_reasons_json: "匹配原因JSON",
  risk_reasons_json: "风险原因JSON",
  ai_evaluation_status: "AI评价状态",
  ai_evaluation_provider: "AI评价提供方",
  ai_evaluation_model: "AI评价模型",
  ai_evaluation_reason: "AI评价说明",
  reevaluation_required: "重新评价要求",
};

const lines = [
  headers.map((header) => csvCell(zh[header] || header)).join(","),
  headers.map(csvCell).join(","),
  headers.map((header) => csvCell(fieldDescriptions[header] || "")).join(","),
  ...evaluated.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
];
fs.writeFileSync(outCsv, "\ufeff" + lines.join("\r\n"), "utf8");
fs.writeFileSync(outJson, JSON.stringify({ ...payload, evaluation_date: evaluationDate, records: evaluated }, null, 2), "utf8");

function groupCounts(rows, field) {
  const out = {};
  for (const row of rows) out[row[field] || ""] = (out[row[field] || ""] || 0) + 1;
  return out;
}

const sorted = [...evaluated].sort((a, b) => {
  if (b.overall_fit_score !== a.overall_fit_score) return b.overall_fit_score - a.overall_fit_score;
  return b.application_success_score - a.application_success_score;
});
const top = sorted.filter((row) => ["重点关注", "重点关注-需确认详情", "可关注"].includes(row.focus_level)).slice(0, 20);
const summary = [
  "# 岗位适配度评价摘要",
  "",
  `评价日期：${evaluationDate}`,
  "",
  "## 文件",
  "",
  `- 输入：\`${path.basename(inputPath)}\``,
  `- 评价 CSV：\`${path.basename(outCsv)}\``,
  `- 评价 JSON：\`${path.basename(outJson)}\``,
  "",
  "## 总览",
  "",
  `- 评价岗位数：${evaluated.length}`,
  `- 重点关注：${evaluated.filter((row) => row.focus_level === "重点关注").length}`,
  `- 重点关注-需确认详情：${evaluated.filter((row) => row.focus_level === "重点关注-需确认详情").length}`,
  `- 可关注：${evaluated.filter((row) => row.focus_level === "可关注").length}`,
  `- 低优先/暂不考虑：${evaluated.filter((row) => ["低优先", "暂不考虑"].includes(row.focus_level)).length}`,
  "",
  "## 关注等级分布",
  "",
  "```json",
  JSON.stringify(groupCounts(evaluated, "focus_level"), null, 2),
  "```",
  "",
  "## Top 候选",
  "",
  "| 关注等级 | 综合分 | 成功分 | 公司 | 岗位 | 薪资 | 搜索词 | 建议 |",
  "| --- | ---: | ---: | --- | --- | --- | --- | --- |",
  ...top.map((row) =>
    `| ${row.focus_level} | ${row.overall_fit_score} | ${row.application_success_score} | ${val(row.company).replace(/\|/g, "/")} | ${val(row.job_title).replace(/\|/g, "/")} | ${val(row.salary).replace(/\|/g, "/")} | ${val(row.keyword).replace(/\|/g, "/")} | ${val(row.application_recommendation).replace(/\|/g, "/")} |`
  ),
  "",
  "## 说明",
  "",
  "- 本轮多数为 `page_text_fallback`，因此重点关注项多为“需确认详情”。",
  "- `评价日期` 是独立字段；后续岗位状态、薪酬、活跃时间或详情补采变化后，应重新评价。",
  "- 原始字段未覆盖，评价字段追加在输出文件末尾。",
].join("\r\n");
fs.writeFileSync(outSummary, summary, "utf8");

console.log(JSON.stringify({
  outCsv,
  outJson,
  outSummary,
  total: evaluated.length,
  focusCounts: groupCounts(evaluated, "focus_level"),
  top: top.slice(0, 10).map((row) => ({
    focus_level: row.focus_level,
    overall_fit_score: row.overall_fit_score,
    application_success_score: row.application_success_score,
    company: row.company,
    job_title: row.job_title,
    salary: row.salary,
    keyword: row.keyword,
  })),
}, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
