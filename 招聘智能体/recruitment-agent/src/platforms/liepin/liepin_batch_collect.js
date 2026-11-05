const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../../core/load_env");
const { cdpBaseUrl, findOrCreateTab, findOrCreateCollectTab, getJson, openWsForTab, navigate, evaluate, sleep } = require("../../core/cdp_common");
const { shanghaiDateKey } = require("../../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../../core/field_dictionary");
const { loadJobStore } = require("../../store/job_store");
const { appendLedgerEntries } = require("../../store/collection_ledger");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..", "..");
const outputsDir = path.join(rootDir, "outputs");
fs.mkdirSync(outputsDir, { recursive: true });

const stageName = process.argv[2] || "stage1";
const perKeyword = Number(process.argv[3] || process.env.LIEPIN_PER_KEYWORD || 5);
const maxTotal = Number(process.argv[4] || process.env.LIEPIN_MAX_TOTAL || 30);
// v1.3：入库要求“平台详细信息 + 唯一 ID”，猎聘默认必须打开详情。
const enableDetail = !/^(false|0|no|off)$/i.test(process.env.LIEPIN_ENABLE_DETAIL || "true");
const targetCity = process.env.TARGET_CITY || "上海";
const planPath = process.argv[6] || process.env.KEYWORD_PLAN_PATH || "";
const totalNewTarget = Number(process.env.LIEPIN_TARGET_NEW || maxTotal);
const detailAttemptLimit = Number(process.env.LIEPIN_DETAIL_ATTEMPT_LIMIT || Math.max(totalNewTarget * 2, totalNewTarget + 5));
const minJdChars = Number(process.env.LIEPIN_MIN_JD_CHARS || 100);
const maxPages = Number(process.env.LIEPIN_MAX_PAGES || 3);

function parseKeywordSpec(text) {
  const raw = text.trim();
  const match = raw.match(/^([^:：]+)[:：]{2}(.+)$/);
  if (!match) return { strategy_type: "未分级", keyword: raw, raw };
  return { strategy_type: match[1].trim(), keyword: match[2].trim(), raw };
}

const keywordSpecs = (process.argv[5] || "岗位信息::AI项目经理,岗位信息::AI产品经理,经历关键词::智能体 项目管理,宽泛词::AI")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map(parseKeywordSpec)
  .filter((item) => item.keyword);

function loadLiepinPlan(filePath) {
  if (!filePath) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const plans = payload.channels?.liepin || payload.liepin || (Array.isArray(payload) ? payload : []);
    return (plans || []).map((item) => ({
      keyword: String(item.keyword || "").trim(),
      strategy_type: item.strategy_type || item.level_type || "未分级",
      target_new: Number(item.target_new || perKeyword),
      max_pages: Number(item.max_pages || maxPages),
      match_score: item.match_score,
      priority: item.priority,
      is_new: item.is_new,
    })).filter((item) => item.keyword);
  } catch {
    return [];
  }
}

const plannedSpecs = loadLiepinPlan(planPath);
const workSpecs = plannedSpecs.length
  ? plannedSpecs
  : keywordSpecs.map((item) => ({
    keyword: item.keyword,
    strategy_type: item.strategy_type,
    target_new: perKeyword,
    max_pages: maxPages,
  }));

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outputsDir, `liepin_${stageName}_jobs_${timestamp}.json`);
const csvPath = path.join(outputsDir, `liepin_${stageName}_jobs_${timestamp}.csv`);

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, "\n")}"`;
}

function addDays(dateString, delta) {
  const date = new Date(`${dateString}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + delta);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function activeDateFromText(text) {
  const today = shanghaiDateKey();
  const s = text || "";
  if (/当前在线|刚刚|分钟|小时|今日|今天/.test(s)) return today;
  if (/昨天/.test(s)) return addDays(today, -1);
  const day = s.match(/(\d+)\s*天/);
  if (day) return addDays(today, -Number(day[1]));
  const week = s.match(/(\d+)\s*周/);
  if (week) return addDays(today, -Number(week[1]) * 7);
  const month = s.match(/(\d+)\s*个?月/);
  if (month) return addDays(today, -Number(month[1]) * 30);
  return "";
}

function parseSalary(salary) {
  const text = salary || "";
  const match = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[kK]/);
  const months = text.match(/[·xX]\s*(\d+)\s*薪/);
  return {
    salary_min_k: match ? Number(match[1]) : "",
    salary_max_k: match ? Number(match[2]) : "",
    salary_months: months ? Number(months[1]) : "",
  };
}

function inferDistrict(text) {
  const districts = ["浦东新区", "黄浦区", "徐汇区", "静安区", "长宁区", "普陀区", "虹口区", "杨浦区", "闵行区", "宝山区", "嘉定区", "松江区", "青浦区", "奉贤区", "金山区", "崇明区"];
  return districts.find((district) => (text || "").includes(district)) || "";
}

function keywordGroup(keyword) {
  const parts = String(keyword || "").split(/[+＋,，、|｜\s]+/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [String(keyword || "").trim()].filter(Boolean);
}

function normalizeKey(...parts) {
  return parts.map((part) => String(part || "").toLowerCase().replace(/\s+/g, "").replace(/[（）()【】\[\]·\-_/]/g, "")).filter(Boolean).join("|");
}

function extractJobId(url) {
  const text = String(url || "");
  const m = text.match(/job[\/-](\d+)|\/(\d+)\.shtml|jobId=([^&]+)/i);
  return m ? (m[1] || m[2] || m[3]) : "";
}

async function findLiepinTab() {
  const base = cdpBaseUrl();
  // 标签隔离：只复用采集自己创建的标签，不复用用户手动打开的标签。
  let tab = await findOrCreateCollectTab("liepin", "https://c.liepin.com/", { isUsable: (t) => Boolean(t.webSocketDebuggerUrl) });
  if ((tab.url || "") === "about:blank") {
    await sleep(2000);
    const current = await getJson(`${base}/json/list`);
    tab = current.find((item) => item.id === tab.id) || tab;
  }
  const freshTabs = await getJson(`${base}/json/list`);
  for (const blank of freshTabs.filter((item) => item.type === "page" && (item.url || "") === "about:blank" && item.id !== tab.id)) {
    await fetch(`${base}/json/close/${blank.id}`).catch(() => {});
  }
  return tab;
}

async function searchKeywordByUi(ws, keyword) {
  const result = await evaluate(ws, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    if (location.href === 'about:blank') return { ok: false, reason: "current tab is about:blank", href: location.href, sample: "" };
    const input = [...document.querySelectorAll('input')].find((el) => /搜索|职位|公司/.test(el.placeholder || '') || /search|keyword/i.test(el.name || el.id || ''));
    if (!input) return { ok: false, reason: "search input not found", href: location.href, sample: (document.body?.innerText || '').slice(0, 300) };
    input.focus();
    input.value = ${JSON.stringify(keyword)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const buttons = [...document.querySelectorAll('button, a, div, span')].filter((el) => /^搜索$/.test((el.innerText || el.textContent || '').trim()));
    const button = buttons.find((el) => el.offsetParent !== null) || buttons[0];
    if (button) button.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
    return { ok: true, href: location.href };
  })()`, 15000);
  await sleep(5500);
  return result;
}

// 2026-09-14 修复：原实现只在「当前页面」的搜索框里输入关键词。
// 采集时当前页是个人中心 c.liepin.com，那里并没有关键词搜索结果，
// 于是每个关键词都只解析到页面上同一批「与您求职期望相似的职位」推荐卡片
// （实测每个关键词都只有 4 条、且与关键词无关，全部标记 page_text_fallback）。
// 改为直接导航到猎聘的关键词搜索页：/zhaopin/?dqs=<城市码>&key=<关键词>
// （020=上海；实测同一关键词能拿到 16 条与关键词强相关的真实职位卡片）。
// 导航失败或没落到搜索页时，保留原来的 UI 输入方式作为兜底。
async function searchKeyword(ws, keyword, page = 1) {
  const cityCode = process.env.LIEPIN_CITY_CODE || "020";
  const pageParam = process.env.LIEPIN_PAGE_PARAM || "page";
  const pageQuery = page > 1 ? `&${encodeURIComponent(pageParam)}=${page}` : "";
  const url = `https://www.liepin.com/zhaopin/?dqs=${encodeURIComponent(cityCode)}&key=${encodeURIComponent(keyword)}${pageQuery}`;
  try {
    await navigate(ws, url, 10000);
    await sleep(Number(process.env.LIEPIN_PAGE_WAIT_MS || 4000));
    const current = (await evaluate(ws, "location.href", 5000)) || "";
    if (/liepin\.com\/zhaopin/i.test(current)) {
      return { ok: true, via: "url_navigation", keyword, page, href: current };
    }
    const fallback = await searchKeywordByUi(ws, keyword);
    return { ...fallback, via: "ui_input_fallback", page, navigatedTo: current };
  } catch (error) {
    const fallback = await searchKeywordByUi(ws, keyword).catch(() => ({ ok: false, reason: error.message, href: "" }));
    return { ...fallback, via: "ui_input_after_nav_error", page, navError: error.message };
  }
}

async function extractCards(ws, keyword, limit) {
  return evaluate(ws, `(() => {
    const keyword = ${JSON.stringify(keyword)};
    const limit = ${Number(limit)};
    const targetCity = ${JSON.stringify(targetCity)};
    const salaryRe = /(\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?\\s*[kK](?:[·xX]\\d+薪)?|面议)/;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 120 && r.height > 40 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const clean = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').trim();
    const findCard = (el) => {
      let node = el;
      for (let i = 0; node && i < 7; i++, node = node.parentElement) {
        const text = (node.innerText || '').trim();
        if (salaryRe.test(text) && text.length > 35 && text.length < 1800) return node;
      }
      return el;
    };
    const nodes = [];
    for (const node of document.querySelectorAll('[class*="job-card-pc-container"], [class*="job-list-item"], [class*="job-detail-box"]')) {
      const text = clean(node.innerText || '');
      if (!visible(node) || text.length < 25 || !salaryRe.test(text) || !text.includes(targetCity)) continue;
      const href = node.querySelector('a[href*="liepin.com"]')?.href
        || node.closest('a[href*="liepin.com"]')?.href
        || node.querySelector('a[href*=".shtml"]')?.href
        || node.closest('a[href*=".shtml"]')?.href
        || '';
      nodes.push({ card: node, href, structured: true });
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      const card = findCard(a);
      const text = (card.innerText || '').trim();
      if (visible(card) && salaryRe.test(text) && (text + href).includes(targetCity)) nodes.push({ card, href });
    }
    for (const node of document.querySelectorAll('div, li, article, section')) {
      const text = (node.innerText || '').trim();
      if (!visible(node) || text.length < 35 || text.length > 1000 || !salaryRe.test(text) || !text.includes(targetCity)) continue;
      const href = node.querySelector('a[href]')?.href || node.closest('a[href]')?.href || '';
      nodes.push({ card: node, href });
    }
    const seen = new Set();
    const rows = [];
    for (const item of nodes) {
      const text = clean(item.card.innerText || '');
      const key = item.href || text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const lines = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const salary = (text.match(salaryRe) || [''])[0];
      const titleNode = item.card.querySelector('[class*="ellipsis-1"], [class*="job-title"], h3, h2');
      const salaryNode = item.card.querySelector('[class*="salary"], [class*="job-salary"]');
      const companyNode = item.card.querySelector('[class*="company-name"], [class*="company-info"], [class*="job-company"]');
      const activeRe = /当前在线|刚刚在线|\\d+\\s*分钟前在线|\\d+\\s*小时前在线|\\d+\\s*天前在线|今日活跃|今天活跃/;
      const firstLine = lines.find((line) => salaryRe.test(line)) || lines[0] || '';
      const nodeTitleText = clean((titleNode?.innerText || '').replace(salaryRe, '')).replace(/【[\\s\\S]*?】|\\[[\\s\\S]*?\\]/g, '').trim();
      const title = nodeTitleText || firstLine.replace(salary, '').replace(/【[^】]+】|\\[[^\\]]+\\]/g, '').trim() || lines[0] || '';
      const locMatch = text.match(/【\\s*([^】]+?)\\s*】|\\[\\s*([^\\]]+?)\\s*\\]/);
      const explicitCity = text.match(new RegExp(targetCity + '[-·—][\\\\u4e00-\\\\u9fa5]{1,8}区?'));
      const loc = clean(locMatch?.[1] || locMatch?.[2] || explicitCity?.[0] || targetCity);
      const experience = (text.match(/经验不限|\\d+\\s*-\\s*\\d+年|\\d+年以上|应届|在校/) || [''])[0];
      const degree = (text.match(/本科|大专|硕士|博士|学历不限|高中|中专/) || [''])[0];
      const active = (text.match(activeRe) || [''])[0];
      const companyLine = clean(companyNode?.innerText || '') || lines.find((line) => /公司|集团|科技|智能|网络|信息|投资|软件|有限|股份/.test(line) && !salaryRe.test(line) && line !== title) || '';
      const cardSalary = clean(salaryNode?.innerText || '') || salary;
      rows.push({ keyword, title, salary: cardSalary, location: loc, experience, degree, active, companyLine, href: item.href, text });
      if (rows.length >= limit) break;
    }
    return { href: location.href, title: document.title, count: rows.length, rows, sample: (document.body?.innerText || '').slice(0, 500) };
  })()`, 20000);
}

async function detailTextFor(ws, url) {
  if (!url) return { detail_text: "", detail_status: "no_link" };
  try {
    await navigate(ws, url, 4500);
    const value = await evaluate(ws, `(() => {
      const text = document.body ? document.body.innerText : "";
      return { href: location.href, title: document.title, text: text.slice(0, 8000) };
    })()`, 15000);
    const text = String(value.text || "").replace(/\s+/g, " ").trim();
    const href = String(value.href || url);
    const looksLikeJob = /\/a\/\d+\.shtml|job\/\d+/i.test(href);
    const looksLikeLogin = /登录|安全验证|验证码|captcha|verify/i.test(text.slice(0, 500));
    return {
      detail_url: href,
      detail_text: text,
      detail_status: looksLikeJob && !looksLikeLogin && text.length >= minJdChars ? "ok" : "empty",
    };
  } catch (error) {
    return { detail_url: url, detail_text: "", detail_status: "error", detail_error: error.message };
  }
}

function buildRecord(card, detail, spec) {
  const allText = `${card.text || ""}\n${detail.detail_text || ""}`;
  const salaryParts = parseSalary(card.salary);
  const jobId = extractJobId(card.href || detail.detail_url);
  const district = inferDistrict(allText);
  const recordKey = jobId ? `liepin:${jobId}` : `liepin:fallback:${normalizeKey(card.companyLine, card.title, card.salary, district || card.location)}`;
  return {
    platform: "猎聘",
    record_key: recordKey,
    platform_job_id: jobId,
    search_strategy_type: spec.strategy_type,
    keyword: spec.keyword,
    source_keyword: spec.keyword,
    source_page: spec.page,
    current_search_keyword_group_json: JSON.stringify(keywordGroup(spec.keyword)),
    collected_at: new Date().toISOString(),
    source: "liepin_cdp_dom",
    company: card.companyLine,
    company_industry: "",
    company_scale: "",
    company_stage: "",
    company_summary: "",
    job_title: card.title,
    salary: card.salary,
    ...salaryParts,
    city: targetCity,
    district,
    business_area: "",
    address: card.location,
    experience: card.experience,
    degree: card.degree,
    tags: "",
    job_description: detail.detail_text || "",
    recruiter_name: "",
    recruiter_title: "",
    recruiter_id: "",
    recruiter_active_text: card.active,
    latest_active_date: activeDateFromText(card.active),
    liepin_job_id: jobId,
    liepin_job_url: card.href || detail.detail_url || "",
    source_url: detail.detail_url || card.href || "",
    page_card_text: card.text,
    detail_status: detail.detail_status,
    collection_status: detail.detail_status === "ok" ? "ok" : "page_text_fallback",
  };
}

function writeOutputs(payload) {
  if (!payload.dateKey) payload.dateKey = shanghaiDateKey();
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  const headers = [
    "platform", "record_key", "platform_job_id", "search_strategy_type", "keyword", "source_keyword", "source_page",
    "current_search_keyword_group_json", "used_search_keyword_groups_json", "search_occurrences_json", "collected_at",
    "company", "company_industry", "company_scale", "company_stage", "job_title", "salary", "salary_min_k", "salary_max_k",
    "salary_months", "city", "district", "address", "experience", "degree", "tags", "job_description", "recruiter_name",
    "recruiter_title", "recruiter_id", "recruiter_active_text", "latest_active_date", "liepin_job_id", "liepin_job_url",
    "source_url", "detail_status", "collection_status", "page_card_text"
  ];
  const lines = [
    headers.map((h) => csvCell(fieldZh[h] || h)).join(","),
    headers.map(csvCell).join(","),
    headers.map((h) => csvCell(fieldDescriptions[h] || "")).join(",")
  ];
  for (const row of payload.records) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  fs.writeFileSync(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");
}

function isRiskError(message) {
  return /安全验证|验证码|captcha|verify|环境异常|访问异常|登录/i.test(String(message || ""));
}

async function main() {
  const store = loadJobStore();
  const existingKeys = new Set(Object.keys(store.jobs || {}));
  const records = [];
  const pending = [];
  const keywordStats = [];
  const ledgerEntries = [];
  const seen = new Map();
  const seenAllKeys = new Set();
  let partial = false;
  let totalNew = 0;
  let totalDetailAttempts = 0;
  let detailBudgetExhausted = false;
  let riskStop = false;

  function addOccurrence(record, spec) {
    const occurrence = {
      strategy_type: spec.strategy_type,
      keyword: spec.keyword,
      keyword_group: keywordGroup(spec.keyword),
      captured_at: new Date().toISOString(),
    };
    const existing = record.search_occurrences_json ? JSON.parse(record.search_occurrences_json) : [];
    if (!existing.some((item) => item.keyword === occurrence.keyword && item.strategy_type === occurrence.strategy_type)) {
      existing.push(occurrence);
    }
    record.search_occurrences_json = JSON.stringify(existing);
    record.used_search_keyword_groups_json = JSON.stringify(
      existing
        .map((item) => item.keyword_group || keywordGroup(item.keyword))
        .filter((group) => group.length)
    );
  }

  for (const spec of workSpecs) {
    if (totalNew >= totalNewTarget || riskStop || detailBudgetExhausted) break;
    const startedAt = Date.now();
    const stats = {
      date: shanghaiDateKey(),
      stage: "collect",
      channel: "猎聘",
      keyword: spec.keyword,
      strategy_type: spec.strategy_type,
      target_new: Number(spec.target_new || perKeyword),
      match_score: spec.match_score,
      priority: spec.priority,
      is_new_keyword: Boolean(spec.is_new),
      pages: 0,
      seen: 0,
      duplicates: 0,
      new_candidates: 0,
      detail_attempts: 0,
      detail_ok: 0,
      detail_fail: 0,
      pending: 0,
      page_errors: 0,
      stop_reason: "",
      elapsed_ms: 0,
      errors: [],
      collectionError: "",
    };
    let ws;
    try {
      const tab = await findLiepinTab();
      ws = await openWsForTab(tab);
      let pageFingerprint = "";
      for (let page = 1; page <= Number(spec.max_pages || maxPages); page += 1) {
        if (totalNew >= totalNewTarget || riskStop) {
          stats.stop_reason = "budget";
          break;
        }
        const remaining = Math.min(stats.target_new - stats.new_candidates, totalNewTarget - totalNew);
        if (remaining <= 0) {
          stats.stop_reason = "target";
          break;
        }
        let extracted;
        try {
          const ui = await searchKeyword(ws, spec.keyword, page);
          await sleep(Number(process.env.LIEPIN_PAGE_SETTLE_MS || 1800));
          extracted = await extractCards(ws, spec.keyword, Math.max(remaining * 3, perKeyword));
          stats.href = extracted.href || "";
          stats.ui = ui;
        } catch (error) {
          stats.page_errors += 1;
          stats.errors.push(error.message);
          stats.collectionError = error.message;
          stats.stop_reason = "page_error";
          partial = true;
          if (isRiskError(error.message)) riskStop = true;
          break;
        }
        stats.pages = page;
        const rows = extracted.rows || [];
        for (const card of rows) {
          const seenJobId = extractJobId(card.href);
          if (seenJobId) seenAllKeys.add(`liepin:${seenJobId}`);
        }
        stats.seen += rows.length;
        const fingerprint = rows.map((card) => card.href || card.title).join("|");
        if (page > 1 && fingerprint && fingerprint === pageFingerprint) {
          stats.stop_reason = "page_repeat";
          break;
        }
        pageFingerprint = fingerprint;
        const pageSeen = new Set();
        let pageNew = 0;

        for (const card of rows) {
          if (totalNew >= totalNewTarget || stats.new_candidates >= stats.target_new) break;
          const jobId = extractJobId(card.href);
          if (!jobId) {
            stats.pending += 1;
            pending.push({ keyword: spec.keyword, page, reason: "missing_platform_job_id", card });
            continue;
          }
          const key = `liepin:${jobId}`;
          if (pageSeen.has(key)) {
            stats.duplicates += 1;
            continue;
          }
          pageSeen.add(key);
          if (seen.has(key) || existingKeys.has(key)) {
            stats.duplicates += 1;
            if (seen.has(key)) addOccurrence(records[seen.get(key)], spec);
            continue;
          }
          if (totalDetailAttempts >= detailAttemptLimit) {
            stats.stop_reason = "detail_budget";
            detailBudgetExhausted = true;
            break;
          }
          stats.detail_attempts += 1;
          totalDetailAttempts += 1;
          const detail = enableDetail
            ? await detailTextFor(ws, card.href)
            : { detail_text: "", detail_status: "skipped", detail_url: card.href || "" };
          const record = buildRecord(card, detail, { ...spec, page });
          if (record.detail_status !== "ok" || String(record.job_description || "").trim().length < minJdChars) {
            stats.detail_fail += 1;
            stats.pending += 1;
            pending.push({
              keyword: spec.keyword,
              page,
              reason: record.detail_status === "ok" ? "jd_too_short" : `detail_${record.detail_status}`,
              job: { jobName: card.title, brandName: card.companyLine, salaryDesc: card.salary },
              detail_url: detail.detail_url || card.href,
            });
            continue;
          }
          addOccurrence(record, spec);
          records.push(record);
          seen.set(key, records.length - 1);
          stats.new_candidates += 1;
          stats.detail_ok += 1;
          pageNew += 1;
          totalNew += 1;
          console.log(JSON.stringify({ platform: "猎聘", count: records.length, keyword: spec.keyword, page, job: record.job_title, company: record.company, status: record.collection_status }, null, 0));
          await sleep(Number(process.env.LIEPIN_DETAIL_WAIT_MS || 1800) + Math.floor(Math.random() * 1200));
        }

        writeOutputs({ stageName, keywordSpecs, workSpecs, perKeyword, maxTotal: totalNewTarget, keywordStats: [...keywordStats, stats], records, pending, complete: false, partial });
        if (detailBudgetExhausted) break;
        if (stats.new_candidates >= stats.target_new) {
          stats.stop_reason = "target";
          break;
        }
        if (totalNew >= totalNewTarget) {
          stats.stop_reason = "budget";
          break;
        }
        if (!rows.length) {
          stats.stop_reason = "no_more";
          break;
        }
        const duplicateRate = stats.seen ? stats.duplicates / stats.seen : 0;
        if (page > 1 && duplicateRate > Number(process.env.LIEPIN_PAGE_DUP_STOP_RATIO || 0.85)) {
          stats.stop_reason = "high_duplicate";
          break;
        }
        if (page >= Number(spec.max_pages || maxPages)) {
          stats.stop_reason = "max_pages";
          break;
        }
      }
    } catch (error) {
      partial = true;
      stats.page_errors += 1;
      stats.errors.push(error.message);
      stats.collectionError = error.message;
      stats.stop_reason = "error";
      if (isRiskError(error.message)) riskStop = true;
      console.error(JSON.stringify({ platform: "猎聘", keyword: spec.keyword, collectionError: error.message }));
    } finally {
      ws?.close();
    }
    stats.elapsed_ms = Date.now() - startedAt;
    stats.candidates = stats.new_candidates;
    stats.strategyType = spec.strategy_type;
    keywordStats.push(stats);
    ledgerEntries.push(stats);
    appendLedgerEntries(shanghaiDateKey(), [stats]);
  }

  // 采集结束后把猎聘标签页还原到个人中心，避免下一轮登录检查误判。
  try {
    const restoreTab = await findLiepinTab();
    const restoreWs = await openWsForTab(restoreTab);
    try {
      await navigate(restoreWs, "https://c.liepin.com/", 8000);
      await sleep(1000);
    } finally {
      restoreWs.close();
    }
  } catch {
    // 还原失败不影响本轮已采集的数据。
  }

  writeOutputs({ stageName, dateKey: shanghaiDateKey(), keywordSpecs, workSpecs, perKeyword, maxTotal: totalNewTarget, keywordStats, records, pending, seen_job_ids: [...seenAllKeys], complete: true, partial });
  console.log(JSON.stringify({ csvPath, jsonPath, total: records.length, pending: pending.length, keywordStats }, null, 2));
  if (partial) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { searchKeyword, extractCards, detailTextFor, buildRecord, extractJobId };
