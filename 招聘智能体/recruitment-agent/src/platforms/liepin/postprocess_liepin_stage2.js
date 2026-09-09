const fs = require("fs");
const path = require("path");
const { shanghaiDateKey } = require("../../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../../core/field_dictionary");

const rootDir = path.resolve(__dirname, "..", "..", "..");
const outputsDir = path.join(rootDir, "outputs");
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

const inputPath = process.argv[2] || latestFile(/^liepin_.*_jobs_.*\.json$/);
const today = process.argv[3] || process.env.EVALUATION_DATE || shanghaiDateKey();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const csvPath = path.join(outputsDir, `liepin_stage2_screened_${stamp}.csv`);
const jsonPath = path.join(outputsDir, `liepin_stage2_screened_${stamp}.json`);
const summaryPath = path.join(outputsDir, `liepin_stage2_summary_${stamp}.json`);

function val(v) {
  if (Array.isArray(v)) return v.join("; ");
  if (v == null) return "";
  return String(v);
}

function csvCell(v) {
  return `"${val(v).replace(/"/g, '""')}"`;
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
  const parts = text.split(/[+＋,，、|｜\s]+/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function groupsFromRecord(record) {
  const groups = [];
  for (const group of parseJsonArray(record.used_search_keyword_groups_json)) {
    if (Array.isArray(group) && group.length) groups.push(group);
  }
  for (const item of parseJsonArray(record.search_occurrences_json)) {
    const group = Array.isArray(item.keyword_group) ? item.keyword_group : keywordGroup(item.keyword);
    if (group.length) groups.push(group);
  }
  const current = parseJsonArray(record.current_search_keyword_group_json);
  if (current.length) groups.push(current);
  const fallback = keywordGroup(record.keyword);
  if (fallback.length) groups.push(fallback);
  return groups;
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
  const text = `${title} ${desc} ${val(record.tags)} ${val(record.page_card_text)}`;
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
    } else if (salary_fit_rechecked === "覆盖20-25K" && nontechnical_fit === "符合" && (activeDays == null || activeDays <= 7)) {
      screen_priority = "高";
    } else if (salary_fit_rechecked === "覆盖20-25K" && nontechnical_fit !== "不符合") {
      screen_priority = "中高";
    } else {
      screen_priority = "中";
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
const exactGroups = new Map();
const semanticGroups = new Map();

for (const record of records) {
  const groups = groupsFromRecord(record);
  const exactKey = record.record_key || record.liepin_job_url || "";
  const semanticKey = normalizeKey(record.company, record.job_title, record.address || record.district || record.city);
  if (exactKey) {
    if (!exactGroups.has(exactKey)) exactGroups.set(exactKey, []);
    exactGroups.get(exactKey).push(...groups);
  }
  if (semanticKey) {
    if (!semanticGroups.has(semanticKey)) semanticGroups.set(semanticKey, []);
    semanticGroups.get(semanticKey).push(...groups);
  }
}

const enriched = records.map((record) => {
  const duplicateKey = normalizeKey(record.company, record.job_title, record.address || record.district || record.city);
  const exactKey = record.record_key || record.liepin_job_url || "";
  const groups = uniqueGroups([...(exactGroups.get(exactKey) || []), ...(semanticGroups.get(duplicateKey) || []), ...groupsFromRecord(record)]);
  return {
    platform: record.platform || "猎聘",
    used_search_keyword_groups_json: JSON.stringify(groups),
    current_search_keyword_group_json: record.current_search_keyword_group_json || JSON.stringify(keywordGroup(record.keyword)),
    ...classify(record, duplicateKey, duplicateSeen),
    ...record,
  };
});

const headers = [];
for (const row of enriched) {
  for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
}
const frontHeaders = [
  "platform", "used_search_keyword_groups_json", "current_search_keyword_group_json", "screen_priority", "screen_reason",
  "nontechnical_fit", "salary_fit_rechecked", "active_days", "ai_signal", "target_role_signal", "is_semantic_duplicate",
  "semantic_duplicate_key"
];
const orderedHeaders = [...frontHeaders, ...headers.filter((h) => !frontHeaders.includes(h))];
const zh = {
  ...fieldZh,
  platform: "平台", used_search_keyword_groups_json: "已用过搜索关键词组JSON", current_search_keyword_group_json: "当前搜索关键词组JSON",
  screen_priority: "筛选优先级", screen_reason: "筛选原因", nontechnical_fit: "非技术岗匹配", salary_fit_rechecked: "薪酬复核",
  active_days: "距最新活跃天数", ai_signal: "AI信号", target_role_signal: "项目/产品/交付信号", is_semantic_duplicate: "语义重复",
  semantic_duplicate_key: "语义去重键", record_key: "去重键", search_strategy_type: "搜索策略类型", keyword: "搜索关键词",
  collected_at: "采集时间", source: "来源", company: "公司", company_industry: "公司行业", company_scale: "公司规模",
  company_stage: "融资阶段", company_summary: "公司简介", job_title: "岗位名称", salary: "薪酬", salary_min_k: "薪酬下限K",
  salary_max_k: "薪酬上限K", salary_months: "薪资月数", city: "城市", district: "区县", business_area: "商圈",
  address: "工作地址", experience: "经验要求", degree: "学历要求", tags: "标签", job_description: "岗位详细描述",
  recruiter_name: "发布/联系人员", recruiter_title: "发布人职位", recruiter_id: "发布人ID", recruiter_active_text: "招聘方活跃时间文本",
  latest_active_date: "最新活跃日期", liepin_job_id: "猎聘岗位ID", liepin_job_url: "猎聘岗位链接", source_url: "来源页面",
  collection_status: "采集状态", page_card_text: "列表卡片文本"
};
const lines = [
  orderedHeaders.map((h) => csvCell(zh[h] || h)).join(","),
  orderedHeaders.map(csvCell).join(","),
  orderedHeaders.map((h) => csvCell(fieldDescriptions[h] || "")).join(",")
];
for (const row of enriched) lines.push(orderedHeaders.map((h) => csvCell(row[h])).join(","));
fs.writeFileSync(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");
fs.writeFileSync(jsonPath, JSON.stringify({ ...payload, platform: "猎聘", records: enriched }, null, 2), "utf8");

function countsBy(field) {
  const out = {};
  for (const row of enriched) out[row[field] || ""] = (out[row[field] || ""] || 0) + 1;
  return out;
}

const summary = {
  inputPath,
  csvPath,
  jsonPath,
  total_records: enriched.length,
  collection_status_counts: countsBy("collection_status"),
  screened_priority_counts: countsBy("screen_priority"),
  nontechnical_fit_counts: countsBy("nontechnical_fit"),
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
