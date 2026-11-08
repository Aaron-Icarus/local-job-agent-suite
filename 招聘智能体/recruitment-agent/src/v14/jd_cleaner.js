const VERSION = "jd-clean-v3";

const SYSTEM_LINE = /^(聊一聊|收藏|微信分享扫码|举报|分享|投诉建议|返回顶部|首页|职位|校园|海归|简历优化|关于猎聘|我要招人|我的投递|我的收藏|猎聘APP)\b/i;
const TAIL_MARKERS = [
  "猎聘温馨提示",
  "猜你喜欢",
  "当前位置：",
  "更新时间：",
  "相似岗位推荐",
  "相关推荐",
  "更多职位推荐",
  "公司简介",
  "公司信息",
  "企业信息",
];

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findFirst(text, markers) {
  let best = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function findLast(text, markers) {
  let best = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index > best) best = index;
  }
  return best;
}

function extractUpdatedAt(text) {
  const iso = text.match(/更新时间\s*[:：]\s*(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const short = text.match(/(\d{1,2})月(\d{1,2})日更新/);
  if (short) {
    const year = new Date().getFullYear();
    return `${year}-${String(Number(short[1])).padStart(2, "0")}-${String(Number(short[2])).padStart(2, "0")}`;
  }
  const full = text.match(/(\d{4})[年.-](\d{1,2})[月.-](\d{1,2})日?\s*更新/);
  if (full) return `${full[1]}-${String(Number(full[2])).padStart(2, "0")}-${String(Number(full[3])).padStart(2, "0")}`;
  return "";
}

function extractRecruiter(text) {
  const pattern = /([^\s\n]{1,12})\s+(刚刚在线|今日在线|在线|\d+\s*(?:分钟|小时|天)前在线|刚刚活跃|今日活跃|\d+\s*(?:分钟|小时|天)前活跃)\s*(已认证)?\s*(猎头顾问|招聘专员|招聘经理|HRBP|HR|人事|猎头|顾问)\s*[·•]\s*([^·\n]+?)(?=\s+(?:聊一聊|职位介绍|职位描述|【职位描述】|其他信息|公司简介)|$)/i;
  const match = text.match(pattern);
  if (!match) return {};
  return {
    recruiter_name: match[1].trim(),
    recruiter_online: match[2].trim(),
    recruiter_certified: match[3] ? 1 : 0,
    recruiter_type: match[4].trim(),
    recruiter_company: match[5].trim(),
  };
}

function extractBossRecruiter(text) {
  // BOSS 页尾常见：黄女士 刚刚活跃 悉地 · 综合行政专员
  const pattern = /([^\s\n]{1,12})\s+(刚刚活跃|今日活跃|在线|\d+\s*(?:分钟|小时|天)前活跃)\s+([^\s·\n]{1,40})\s*[·•]\s*([^\n]+?)(?=\s+(?:聊一聊|职位介绍|职位描述|岗位职责|公司简介)\b|$)/i;
  const match = text.match(pattern);
  if (!match) return {};
  return {
    recruiter_name: match[1].trim(),
    recruiter_online: match[2].trim(),
    recruiter_certified: 0,
    recruiter_type: "招聘方",
    recruiter_company: match[3].trim(),
    recruiter_title: match[4].trim(),
  };
}

function restoreFormatting(text) {
  let value = String(text || "");
  value = value.replace(/\s+(?=(?:岗位定位|职责|工作职责|任职要求|职位要求|加分项|其他信息|公司简介|岗位职责|职位描述|职位介绍|工作内容)(?=[：:\s]|$))/g, "\n\n");
  value = value.replace(/(岗位定位|职责|工作职责|任职要求|职位要求|加分项|其他信息)[：:]\s*/g, "$1：\n");
  value = value.replace(/(岗位定位|职责|工作职责|任职要求|职位要求|加分项|其他信息)\s+(?=\S)/g, "$1\n");
  value = value.replace(/\s+(?=\d{1,2}[.、]\s*)/g, "\n");
  value = value.replace(/\s+(?=\d{1,2}-\s*)/g, "\n");
  value = value.replace(/\s+(?=[•·]\s*)/g, "\n");
  return normalizeText(value);
}

function parseBrief(text) {
  const salary = text.match(/(\d{1,3})\s*-\s*(\d{1,3})\s*[kK](?:[·.]\s*\d+\s*薪)?/);
  const experience = text.match(/(\d{1,2}\s*年以下|\d{1,2}\s*-\s*\d{1,2}\s*年|经验不限|应届生|在校生)/);
  const degree = text.match(/(博士|硕士|本科|大专|中专|高中|学历不限)/);
  const hc = text.match(/招\s*(\d+)\s*人/);
  const city = text.match(/(北京|上海|天津|重庆|广州|深圳|杭州|苏州|成都|武汉|南京|西安|长沙|郑州|青岛|宁波|厦门|合肥|佛山|东莞|无锡|济南|福州|大连|沈阳|昆明|哈尔滨|长春|石家庄|南昌|贵阳|南宁|太原|海口|兰州|乌鲁木齐|呼和浩特|银川|西宁|拉萨)(?:市)?/);
  return {
    salary_text: salary ? `${salary[1]}-${salary[2]}K` : "",
    salary_min_k: salary ? Number(salary[1]) : null,
    salary_max_k: salary ? Number(salary[2]) : null,
    experience: experience ? experience[1].replace(/\s+/g, "") : "",
    degree: degree ? degree[1] : "",
    hc_count: hc ? Number(hc[1]) : null,
    city: city ? city[1] : "",
  };
}

function cleanJobDescription(raw, platform = "") {
  const text = normalizeText(raw);
  const isLiepin = /猎聘|liepin/i.test(platform) || /【职位描述】|猎聘温馨提示|猜你喜欢/.test(text);
  const start = findFirst(text, ["【职位描述】", "职位介绍", "岗位介绍", "职位描述", "岗位职责", "工作职责", "职位详情"]);
  const tail = findLast(text, TAIL_MARKERS);
  let body = text.slice(start >= 0 ? start : 0, tail > (start >= 0 ? start : 0) ? tail : text.length);
  const lines = body.split("\n").map((line) => line.replace(/\s+$/g, ""));
  const filtered = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (filtered.length && filtered[filtered.length - 1] !== "") filtered.push("");
      continue;
    }
    if (SYSTEM_LINE.test(trimmed)) continue;
    if (/^(聊一聊|收藏|微信分享扫码|举报|分享|投诉建议)$/i.test(trimmed)) continue;
    if (/^(邵女士|潘女士|吴先生|李先生|王女士|张女士)\s+.*(?:在线|活跃)/.test(trimmed)) continue;
    filtered.push(line);
  }
  let cleaned = restoreFormatting(filtered.join("\n"));
  if (isLiepin) {
    cleaned = cleaned
      .replace(/^【职位描述】\s*\n?/, "")
      .replace(/^职位介绍\s*\n?/, "")
      .replace(/\n?(猎聘温馨提示|猜你喜欢|当前位置：|公司简介|公司信息)[\s\S]*$/g, "")
      .trim();
  }
  // BOSS 常见页尾：招聘人/活跃状态，不属于 JD
  cleaned = cleaned.replace(/\s+[^\n]{1,12}\s+(?:刚刚活跃|今日活跃|在线|\d+\s*(?:分钟|小时|天)前活跃)\s+[\s\S]{0,160}$/g, "").trim();
  const updatedAt = extractUpdatedAt(text);
  const bossRecruiter = extractBossRecruiter(text);
  const recruiter = (/boss|直聘/i.test(platform)
    ? (bossRecruiter && Object.keys(bossRecruiter).length ? bossRecruiter : extractRecruiter(text))
    : extractRecruiter(text)) || bossRecruiter || {};
  const brief = parseBrief(text.slice(0, Math.max(0, start >= 0 ? start : 2500)));
  return {
    jd_clean_text: cleaned,
    jd_clean_version: VERSION,
    job_updated_at: updatedAt,
    ...recruiter,
    ...brief,
  };
}

function cleanJobs(db, options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 500)));
  const rows = db.prepare(
    `SELECT job_uuid, platform, job_description, jd_clean_version FROM jobs
     WHERE length(coalesce(job_description,'')) > 0
       AND (jd_clean_text = '' OR jd_clean_version <> ?)
     ORDER BY updated_at DESC LIMIT ?`
  ).all(VERSION, limit);
  const update = db.prepare(
    `UPDATE jobs SET jd_clean_text = ?, jd_clean_version = ?,
       job_updated_at = CASE WHEN ? <> '' THEN ? ELSE job_updated_at END,
       recruiter_name = CASE WHEN ? <> '' THEN ? ELSE recruiter_name END,
       recruiter_online = CASE WHEN ? <> '' THEN ? ELSE recruiter_online END,
       recruiter_certified = CASE WHEN ? <> '' THEN ? ELSE recruiter_certified END,
       recruiter_type = CASE WHEN ? <> '' THEN ? ELSE recruiter_type END,
       recruiter_title = CASE WHEN ? <> '' THEN ? ELSE recruiter_title END,
       recruiter_company = CASE WHEN ? <> '' THEN ? ELSE recruiter_company END,
       hc_count = CASE WHEN ? IS NOT NULL THEN ? ELSE hc_count END,
       experience = CASE WHEN ? <> '' THEN ? ELSE experience END,
       degree = CASE WHEN ? <> '' THEN ? ELSE degree END,
       salary_text = CASE WHEN ? <> '' THEN ? ELSE salary_text END,
       salary_min_k = CASE WHEN ? IS NOT NULL THEN ? ELSE salary_min_k END,
       salary_max_k = CASE WHEN ? IS NOT NULL THEN ? ELSE salary_max_k END,
       city = CASE WHEN ? <> '' THEN ? ELSE city END,
       updated_at = ?
     WHERE job_uuid = ?`
  );
  let cleaned = 0;
  for (const row of rows) {
    const result = cleanJobDescription(row.job_description, row.platform);
    const now = new Date().toISOString();
    update.run(
      result.jd_clean_text, result.jd_clean_version,
      result.job_updated_at, result.job_updated_at,
      result.recruiter_name || "", result.recruiter_name || "",
      result.recruiter_online || "", result.recruiter_online || "",
      result.recruiter_certified ? "1" : "", result.recruiter_certified || 0,
      result.recruiter_type || "", result.recruiter_type || "",
      result.recruiter_title || "", result.recruiter_title || "",
      result.recruiter_company || "", result.recruiter_company || "",
      result.hc_count, result.hc_count,
      result.experience || "", result.experience || "",
      result.degree || "", result.degree || "",
      result.salary_text || "", result.salary_text || "",
      result.salary_min_k, result.salary_min_k,
      result.salary_max_k, result.salary_max_k,
      result.city || "", result.city || "",
      now, row.job_uuid
    );
    cleaned += 1;
  }
  return { cleaned, version: VERSION };
}

module.exports = { VERSION, cleanJobDescription, cleanJobs, extractUpdatedAt, extractRecruiter };
