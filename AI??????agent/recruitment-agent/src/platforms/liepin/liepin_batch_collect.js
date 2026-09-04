const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../../core/load_env");
const { cdpBaseUrl, findOrCreateTab, getJson, openWsForTab, navigate, evaluate, sleep } = require("../../core/cdp_common");
const { shanghaiDateKey } = require("../../core/time_utils");
const { fieldZh, fieldDescriptions } = require("../../core/field_dictionary");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..", "..");
const outputsDir = path.join(rootDir, "outputs");
fs.mkdirSync(outputsDir, { recursive: true });

const stageName = process.argv[2] || "stage1";
const perKeyword = Number(process.argv[3] || process.env.LIEPIN_PER_KEYWORD || 5);
const maxTotal = Number(process.argv[4] || process.env.LIEPIN_MAX_TOTAL || 30);
const enableDetail = /^true$/i.test(process.env.LIEPIN_ENABLE_DETAIL || "false");
const targetCity = process.env.TARGET_CITY || "上海";

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
  let tabs = await getJson(`${base}/json/list`);
  let tab = tabs.find((item) => item.type === "page" && item.webSocketDebuggerUrl && /^https?:\/\/c\.liepin\.com\/?/.test(item.url || ""))
    || tabs.find((item) => item.type === "page" && item.webSocketDebuggerUrl && /liepin\.com/.test(item.url || "") && (item.url || "") !== "about:blank");
  if (!tab) {
    await getJson(`${base}/json/new?https://c.liepin.com/`, { method: "PUT" });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !tab) {
      await sleep(1000);
      tabs = await getJson(`${base}/json/list`);
      tab = tabs.find((item) => item.type === "page" && item.webSocketDebuggerUrl && /^https?:\/\/c\.liepin\.com\/?/.test(item.url || ""))
        || tabs.find((item) => item.type === "page" && item.webSocketDebuggerUrl && /liepin\.com/.test(item.url || "") && (item.url || "") !== "about:blank");
    }
  }
  if (!tab) {
    tab = await findOrCreateTab((url) => /liepin\.com/.test(url), "https://c.liepin.com/");
  }
  const freshTabs = await getJson(`${base}/json/list`);
  for (const blank of freshTabs.filter((item) => item.type === "page" && (item.url || "") === "about:blank")) {
    await fetch(`${base}/json/close/${blank.id}`).catch(() => {});
  }
  await fetch(`${base}/json/activate/${tab.id}`).catch(() => {});
  const afterActivate = await getJson(`${base}/json/list`);
  tab = afterActivate.find((item) => item.id === tab.id) || tab;
  return tab;
}

async function searchKeyword(ws, keyword) {
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

async function detailTextFor(url) {
  if (!url) return { detail_text: "", detail_status: "no_link" };
  const tab = await findOrCreateTab((u) => u === url, url);
  const ws = await openWsForTab(tab);
  try {
    await navigate(ws, url, 4500);
    const value = await evaluate(ws, `(() => {
      const text = document.body ? document.body.innerText : "";
      return { href: location.href, title: document.title, text: text.slice(0, 6000) };
    })()`, 15000);
    return { detail_url: value.href || url, detail_text: value.text || "", detail_status: value.text ? "ok" : "empty" };
  } finally {
    ws.close();
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
    search_strategy_type: spec.strategy_type,
    keyword: spec.keyword,
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
    job_description: detail.detail_text || card.text,
    recruiter_name: "",
    recruiter_title: "",
    recruiter_id: "",
    recruiter_active_text: card.active,
    latest_active_date: activeDateFromText(card.active),
    liepin_job_id: jobId,
    liepin_job_url: card.href || detail.detail_url || "",
    source_url: detail.detail_url || card.href || "",
    page_card_text: card.text,
    collection_status: detail.detail_status === "ok" ? "ok" : "page_text_fallback",
  };
}

function writeOutputs(payload) {
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  const headers = [
    "platform", "record_key", "search_strategy_type", "keyword", "current_search_keyword_group_json",
    "used_search_keyword_groups_json", "search_occurrences_json", "collected_at",
    "company", "company_industry", "company_scale", "company_stage", "job_title", "salary", "salary_min_k", "salary_max_k",
    "salary_months", "city", "district", "address", "experience", "degree", "tags", "job_description", "recruiter_name",
    "recruiter_title", "recruiter_id", "recruiter_active_text", "latest_active_date", "liepin_job_id", "liepin_job_url",
    "source_url", "collection_status", "page_card_text"
  ];
  const lines = [
    headers.map((h) => csvCell(fieldZh[h] || h)).join(","),
    headers.map(csvCell).join(","),
    headers.map((h) => csvCell(fieldDescriptions[h] || "")).join(",")
  ];
  for (const row of payload.records) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  fs.writeFileSync(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");
}

async function main() {
  const records = [];
  const rawItems = [];
  const keywordStats = [];
  const seen = new Map();
  let partial = false;

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

  for (const spec of keywordSpecs) {
    if (records.length >= maxTotal) break;
    const tab = await findLiepinTab();
    const ws = await openWsForTab(tab);
    try {
      const ui = await searchKeyword(ws, spec.keyword);
      await sleep(2500);
      ws.close();
      const freshTab = await findLiepinTab();
      const readWs = await openWsForTab(freshTab);
      const extracted = await extractCards(readWs, spec.keyword, perKeyword);
      readWs.close();
      keywordStats.push({ strategyType: spec.strategy_type, keyword: spec.keyword, ui, href: extracted.href, candidates: extracted.count, sample: extracted.sample });
      for (const card of extracted.rows || []) {
        if (records.length >= maxTotal) break;
        const dedupe = card.href || normalizeKey(card.companyLine, card.title, card.salary, card.location);
        if (seen.has(dedupe)) {
          const existing = records[seen.get(dedupe)];
          addOccurrence(existing, spec);
          writeOutputs({ stageName, keywordSpecs, perKeyword, maxTotal, keywordStats, records, rawItems });
          continue;
        }
        const detail = enableDetail
          ? await detailTextFor(card.href)
          : { detail_text: "", detail_status: "skipped", detail_url: card.href || "" };
        rawItems.push({ spec, card, detail });
        const record = buildRecord(card, detail, spec);
        addOccurrence(record, spec);
        seen.set(dedupe, records.length);
        records.push(record);
        console.log(JSON.stringify({ platform: "猎聘", count: records.length, keyword: spec.keyword, job: record.job_title, company: record.company, status: record.collection_status }, null, 0));
        writeOutputs({ stageName, keywordSpecs, perKeyword, maxTotal, keywordStats, records, rawItems });
        await sleep(2500 + Math.floor(Math.random() * 1500));
      }
    } catch (error) {
      partial = true;
      keywordStats.push({ strategyType: spec.strategy_type, keyword: spec.keyword, collectionError: error.message, candidates: 0 });
      writeOutputs({ stageName, keywordSpecs, perKeyword, maxTotal, keywordStats, records, rawItems, complete: false, partial });
      console.error(JSON.stringify({ platform: "猎聘", keyword: spec.keyword, collectionError: error.message }));
    } finally {
      ws.close();
    }
  }
  writeOutputs({ stageName, keywordSpecs, perKeyword, maxTotal, keywordStats, records, rawItems, complete: true, partial });
  console.log(JSON.stringify({ csvPath, jsonPath, total: records.length, keywordStats }, null, 2));
  if (partial) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
