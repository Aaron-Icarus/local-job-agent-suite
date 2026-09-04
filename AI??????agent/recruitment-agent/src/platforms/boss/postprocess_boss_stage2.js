const fs = require("fs");
const path = require("path");
const { shanghaiDateKey } = require("../../core/time_utils");

const processDir = path.resolve(__dirname, "..", "..", "..");
const outputsDir = path.join(processDir, "outputs");
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

const inputPath = process.argv[2] || latestFile(/^boss_.*_jobs_.*\.json$/);
const today = process.argv[3] || process.env.EVALUATION_DATE || shanghaiDateKey();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const csvPath = path.join(outputsDir, `boss_stage2_screened_${stamp}.csv`);
const jsonPath = path.join(outputsDir, `boss_stage2_screened_${stamp}.json`);
const summaryPath = path.join(outputsDir, `boss_stage2_summary_${stamp}.json`);

function val(v) {
  if (Array.isArray(v)) return v.join("; ");
  if (v == null) return "";
  return String(v);
}

function csvCell(v) {
  const s = val(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function daysBetween(dateText) {
  if (!dateText) return null;
  const d = new Date(`${dateText}T00:00:00+08:00`);
  const t = new Date(`${today}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((t - d) / 86400000);
}

function normalizeKey(...parts) {
  return parts
    .map((part) => val(part).toLowerCase().replace(/\s+/g, "").replace(/[（）()【】\[\]·\-_/]/g, ""))
    .filter(Boolean)
    .join("|");
}

function keywordGroup(keyword) {
  const text = val(keyword).trim();
  if (!text) return [];
  const explicitParts = text
    .split(/[+＋,，、|｜\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return explicitParts.length > 1 ? explicitParts : [text];
}

function uniqueGroups(groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    const key = JSON.stringify(group);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(group);
  }
  return out;
}

function classify(record, duplicateKey, duplicateSeen) {
  const title = val(record.job_title);
  const desc = val(record.job_description);
  const text = `${title} ${desc} ${val(record.skills)}`;
  const salaryMin = n(record.salary_min_k);
  const salaryMax = n(record.salary_max_k);
  const activeDays = daysBetween(record.latest_active_date);
  const aiSignal = /AI|人工智能|智能体|Agent|大模型|AIGC|LLM|RAG|知识库|多模态|机器人|具身|AI平台|智能问答|机器学习|深度学习/i.test(text);
  const targetRole = /项目经理|产品经理|PMO|交付|实施|项目负责人|项目管理|产品总监|产品专家|解决方案|需求/i.test(title);
  const titleSales = /销售|商务|BD|客户经理|渠道|市场推广|直播|电商运营/i.test(title);
  const techSignal = /开发|研发|算法|测试|运维|工程师|架构|Java|Python|后端|前端|CTO|技术负责人|技术专家|Leader|技术部副经理/i.test(title);
  const managerSignal = /项目经理|产品经理|PMO|交付经理|实施经理|需求|项目管理|项目负责人|产品总监|产品专家/i.test(title);

  let nontechnical_fit = "符合";
  if (titleSales) nontechnical_fit = "不符合";
  else if (techSignal && !managerSignal) nontechnical_fit = "不符合";
  else if (techSignal && managerSignal) nontechnical_fit = "边界";

  let salary_fit_rechecked = "未知";
  if (salaryMin != null && salaryMax != null) {
    if (salaryMax < 20) salary_fit_rechecked = "最高低于20K";
    else if (salaryMin > 25) salary_fit_rechecked = "最低高于25K";
    else if (salaryMin <= 25 && salaryMax >= 20) salary_fit_rechecked = "覆盖20-25K";
  }

  const reasons = [];
  let screen_priority = "中";
  const isSemanticDuplicate = duplicateSeen.has(duplicateKey);

  const usableStatus = record.collection_status === "ok" || record.collection_status === "page_text_fallback";
  if (!usableStatus) {
    screen_priority = "待补采";
    reasons.push(`采集状态=${record.collection_status}`);
  } else if (isSemanticDuplicate) {
    screen_priority = "重复";
    reasons.push("公司+岗位+地址语义重复");
  } else {
    if (!aiSignal) reasons.push("AI信号不明显");
    if (!targetRole) reasons.push("岗位角色不够项目/产品/交付");
    if (nontechnical_fit === "不符合") reasons.push("标题偏技术/销售/运营");
    if (nontechnical_fit === "边界") reasons.push("标题含技术岗信号，需人工复核");
    if (salary_fit_rechecked === "最高低于20K") reasons.push("薪资整体偏低");
    if (salary_fit_rechecked === "最低高于25K") reasons.push("薪资最低值高于目标上限");
    if (activeDays != null && activeDays > 30) reasons.push("超过一个月不活跃");
    else if (activeDays != null && activeDays > 14) reasons.push("超过两周不活跃");
    else if (activeDays != null && activeDays > 7) reasons.push("超过一周不活跃");

    if (nontechnical_fit === "不符合" || !aiSignal || !targetRole || salary_fit_rechecked === "最高低于20K" || salary_fit_rechecked === "最低高于25K") {
      screen_priority = "低";
    } else if (activeDays != null && activeDays > 30) {
      screen_priority = "不用考虑";
    } else if (activeDays != null && activeDays > 14) {
      screen_priority = "低";
    } else if (salary_fit_rechecked === "覆盖20-25K" && nontechnical_fit === "符合" && activeDays != null && activeDays <= 7) {
      screen_priority = "高";
    } else if (salary_fit_rechecked === "覆盖20-25K" && nontechnical_fit !== "不符合") {
      screen_priority = "中高";
    } else {
      screen_priority = "中";
    }
    if (record.collection_status === "page_text_fallback" && screen_priority === "高") {
      screen_priority = "中高";
      reasons.push("页面文本兜底，需人工打开确认详情");
    }
  }

  if (!isSemanticDuplicate) duplicateSeen.add(duplicateKey);

  return {
    screen_priority,
    screen_reason: reasons.join("；") || "符合当前阶段规则",
    nontechnical_fit,
    salary_fit_rechecked,
    active_days: activeDays == null ? "" : activeDays,
    ai_signal: aiSignal ? "是" : "否",
    target_role_signal: targetRole ? "是" : "否",
    semantic_duplicate_key: duplicateKey,
    is_semantic_duplicate: isSemanticDuplicate ? "是" : "否",
  };
}

const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const records = payload.records || [];
const duplicateSeen = new Set();
const exactKeywordGroups = new Map();
const semanticKeywordGroups = new Map();

for (const record of records) {
  const group = keywordGroup(record.keyword);
  const exactKey = record.record_key || (record.job_id ? `boss:${record.job_id}` : "");
  const semanticKey = normalizeKey(record.company, record.job_title, record.address || record.district || record.city);
  if (exactKey) {
    if (!exactKeywordGroups.has(exactKey)) exactKeywordGroups.set(exactKey, []);
    exactKeywordGroups.get(exactKey).push(group);
  }
  if (semanticKey) {
    if (!semanticKeywordGroups.has(semanticKey)) semanticKeywordGroups.set(semanticKey, []);
    semanticKeywordGroups.get(semanticKey).push(group);
  }
}

const enriched = records.map((record) => {
  const duplicateKey = normalizeKey(record.company, record.job_title, record.address || record.district || record.city);
  const exactKey = record.record_key || (record.job_id ? `boss:${record.job_id}` : "");
  const groups = uniqueGroups([
    ...(exactKeywordGroups.get(exactKey) || []),
    ...(semanticKeywordGroups.get(duplicateKey) || []),
  ]);
  return {
    used_search_keyword_groups_json: JSON.stringify(groups),
    current_search_keyword_group_json: JSON.stringify(keywordGroup(record.keyword)),
    ...classify(record, duplicateKey, duplicateSeen),
    ...record,
  };
});

const frontHeaders = [
  "used_search_keyword_groups_json",
  "current_search_keyword_group_json",
  "screen_priority",
  "screen_reason",
  "nontechnical_fit",
  "salary_fit_rechecked",
  "active_days",
  "ai_signal",
  "target_role_signal",
  "is_semantic_duplicate",
  "semantic_duplicate_key",
];
const originalHeaders = [
  "record_key",
  "search_strategy_type",
  "search_strategy_types_json",
  "keyword",
  "search_occurrences_json",
  "collected_at",
  "source",
  "company",
  "company_industry",
  "company_scale",
  "company_stage",
  "company_summary",
  "job_title",
  "salary",
  "salary_min_k",
  "salary_max_k",
  "salary_months",
  "city",
  "district",
  "business_area",
  "address",
  "experience",
  "degree",
  "skills",
  "welfare",
  "job_description",
  "refresh_time",
  "boss_name",
  "boss_title",
  "boss_id",
  "boss_active_text",
  "latest_active_date",
  "boss_online",
  "job_id",
  "security_id",
  "lid",
  "detail_url",
  "location_priority",
  "salary_priority",
  "role_fit",
  "activity_priority",
  "overall_priority",
  "notes",
  "collection_status",
];
const headers = [...frontHeaders, ...originalHeaders];
const zh = {
  screen_priority: "筛选优先级",
  screen_reason: "筛选原因",
  nontechnical_fit: "非技术岗匹配",
  salary_fit_rechecked: "薪酬复核",
  active_days: "距最新活跃天数",
  ai_signal: "AI信号",
  target_role_signal: "项目/产品/交付信号",
  is_semantic_duplicate: "语义重复",
  semantic_duplicate_key: "语义去重键",
  used_search_keyword_groups_json: "已用过搜索关键词组JSON",
  current_search_keyword_group_json: "当前搜索关键词组JSON",
  record_key: "去重键",
  search_strategy_type: "搜索策略类型",
  search_strategy_types_json: "搜索策略类型JSON",
  keyword: "搜索关键词",
  search_occurrences_json: "搜索出现记录JSON",
  collected_at: "采集时间",
  source: "来源",
  company: "公司",
  company_industry: "公司行业",
  company_scale: "公司规模",
  company_stage: "融资阶段",
  company_summary: "公司简介",
  job_title: "岗位名称",
  salary: "薪酬",
  salary_min_k: "薪酬下限K",
  salary_max_k: "薪酬上限K",
  salary_months: "薪资月数",
  city: "城市",
  district: "区县",
  business_area: "商圈",
  address: "工作地址",
  experience: "经验要求",
  degree: "学历要求",
  skills: "技能标签",
  welfare: "福利",
  job_description: "岗位详细描述",
  refresh_time: "岗位刷新时间",
  boss_name: "发布人",
  boss_title: "发布人职位",
  boss_id: "发布人ID",
  boss_active_text: "活跃时间文本",
  latest_active_date: "最新活跃日期",
  boss_online: "发布人在线",
  job_id: "岗位ID",
  security_id: "安全ID",
  lid: "列表LID",
  detail_url: "详情接口URL",
  location_priority: "地点优先级",
  salary_priority: "薪酬优先级",
  role_fit: "岗位匹配度",
  activity_priority: "活跃度优先级",
  overall_priority: "综合优先级",
  notes: "判断备注",
  collection_status: "采集状态",
};

const lines = [
  headers.map((header) => csvCell(zh[header] || header)).join(","),
  headers.map(csvCell).join(","),
];
for (const row of enriched) lines.push(headers.map((header) => csvCell(row[header])).join(","));
fs.writeFileSync(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");
fs.writeFileSync(jsonPath, JSON.stringify({ ...payload, records: enriched }, null, 2), "utf8");

function countsBy(field) {
  const out = {};
  for (const row of enriched) out[row[field] || ""] = (out[row[field] || ""] || 0) + 1;
  return out;
}

  const okRows = enriched.filter((row) => row.collection_status === "ok");
const usableRows = enriched.filter((row) => row.collection_status === "ok" || row.collection_status === "page_text_fallback");
const summary = {
  inputPath,
  csvPath,
  jsonPath,
  total_records: enriched.length,
  ok_records: okRows.length,
  usable_records: usableRows.length,
  collection_status_counts: countsBy("collection_status"),
  original_priority_counts: countsBy("overall_priority"),
  screened_priority_counts: countsBy("screen_priority"),
  nontechnical_fit_counts: countsBy("nontechnical_fit"),
  code37_like: enriched.filter((row) => /37|环境异常/.test(`${row.notes || ""} ${row.job_description || ""}`)).length,
  semantic_duplicates: enriched.filter((row) => row.is_semantic_duplicate === "是").length,
  high_examples: enriched
    .filter((row) => row.screen_priority === "高")
    .slice(0, 12)
    .map((row) => ({
      keyword: row.keyword,
      company: row.company,
      job_title: row.job_title,
      salary: row.salary,
      district: row.district,
      boss_active_text: row.boss_active_text,
      latest_active_date: row.latest_active_date,
      reason: row.screen_reason,
    })),
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
