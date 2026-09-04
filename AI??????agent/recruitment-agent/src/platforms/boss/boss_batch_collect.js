const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../../core/load_env");

loadEnv();

const processDir = path.resolve(__dirname, "..", "..", "..");
const outputsDir = path.join(processDir, "outputs");
fs.mkdirSync(outputsDir, { recursive: true });

const stageName = process.argv[2] || "stage1";
const perKeyword = Number(process.argv[3] || 10);
const maxTotal = Number(process.argv[4] || 50);
const cdpHost = process.env.CDP_HOST || "127.0.0.1";
const cdpPort = process.env.CDP_PORT || "9222";
const cdpBaseUrl = process.env.CDP_BASE_URL || `http://${cdpHost}:${cdpPort}`;
function parseKeywordSpec(text) {
  const raw = text.trim();
  const match = raw.match(/^([^:：]+)[:：]{2}(.+)$/);
  if (!match) return { strategy_type: "未分级", keyword: raw, raw };
  return { strategy_type: match[1].trim(), keyword: match[2].trim(), raw };
}
const keywordSpecs = (process.argv[5] || "岗位信息::AI项目经理,岗位信息::AI产品经理,岗位信息::智能体项目经理,岗位信息::大模型项目经理,岗位信息::AI PMO")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map(parseKeywordSpec)
  .filter((item) => item.keyword);
const keywords = keywordSpecs.map((item) => item.keyword);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const csvPath = path.join(outputsDir, `boss_${stageName}_jobs_${timestamp}.csv`);
const jsonPath = path.join(outputsDir, `boss_${stageName}_jobs_${timestamp}.json`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function findTab() {
  const tabs = await getJson(`${cdpBaseUrl}/json`);
  const tab = tabs.find((item) => item.type === "page" && item.webSocketDebuggerUrl && (item.url || "").includes("zhipin.com"));
  if (!tab) throw new Error(`No zhipin.com page found on CDP endpoint ${cdpBaseUrl}.`);
  return tab;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();
  const handlers = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const pair = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? pair.reject(new Error(JSON.stringify(msg.error))) : pair.resolve(msg.result);
      return;
    }
    handlers.forEach((handler) => handler(msg));
  };

  ws.cmd = (method, params = {}, timeoutMs = 15000) => {
    const callId = id++;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(callId)) return;
        pending.delete(callId);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      pending.set(callId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  };

  ws.onEvent = (handler) => handlers.push(handler);
  return ws;
}

async function openWs() {
  const tab = await findTab();
  const ws = connect(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await ws.cmd("Runtime.enable");
  await ws.cmd("Network.enable");
  await ws.cmd("Page.enable");
  return { tab, ws };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, "\n")}"`;
}

function todayShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDays(dateString, delta) {
  const date = new Date(`${dateString}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + delta);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function activeDateFromText(activeText, bossOnline) {
  const today = todayShanghai();
  const text = activeText || "";
  if (bossOnline === true || (/刚刚|在线|今日|今天|活跃/.test(text) && !/\d+\s*(天|周|个?月)/.test(text))) return today;
  if (/昨天/.test(text)) return addDays(today, -1);
  if (/前天/.test(text)) return addDays(today, -2);
  const day = text.match(/(\d+)\s*天/);
  if (day) return addDays(today, -Number(day[1]));
  const week = text.match(/(\d+)\s*周/);
  if (week) return addDays(today, -Number(week[1]) * 7);
  const month = text.match(/(\d+)\s*个?月/);
  if (month) return addDays(today, -Number(month[1]) * 30);
  if (/一周/.test(text)) return addDays(today, -7);
  if (/两周|二周/.test(text)) return addDays(today, -14);
  if (/一个月|1个月/.test(text)) return addDays(today, -30);
  return "";
}

function parseSalary(salary) {
  const text = salary || "";
  const match = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
  const months = text.match(/[·xX]\s*(\d+)\s*薪/);
  return {
    salary_min_k: match ? Number(match[1]) : "",
    salary_max_k: match ? Number(match[2]) : "",
    salary_months: months ? Number(months[1]) : "",
  };
}

function salaryPriority(minK, maxK) {
  if (minK === "" || maxK === "") return { salary_priority: "待判断", salary_note: "薪资格式未解析" };
  if (maxK < 20) return { salary_priority: "暂不考虑", salary_note: "薪资最高值低于20K" };
  if (minK > 25) return { salary_priority: "暂不考虑", salary_note: "薪资最低值高于25K，超出当前目标档位" };
  if (minK <= 25 && maxK >= 20) return { salary_priority: "保留", salary_note: "与20K-25K目标区间有交集" };
  return { salary_priority: "低优先", salary_note: "薪资区间与目标不完全匹配" };
}

function inferShanghaiDistrict(...texts) {
  const combined = texts.filter(Boolean).join(" ");
  const districts = [
    "浦东新区",
    "黄浦区",
    "徐汇区",
    "静安区",
    "长宁区",
    "普陀区",
    "虹口区",
    "杨浦区",
    "闵行区",
    "宝山区",
    "嘉定区",
    "松江区",
    "青浦区",
    "奉贤区",
    "金山区",
    "崇明区",
  ];
  return districts.find((district) => combined.includes(district)) || "";
}

function locationPriority(district) {
  if (!district) return { location_priority: "待判断", location_note: "" };
  if (district.includes("浦东")) return { location_priority: "中低", location_note: "浦东可考虑但优先级相对低" };
  return { location_priority: "高", location_note: "上海非浦东区域" };
}

function roleFit(jobName, description, skills) {
  const text = `${jobName || ""} ${description || ""} ${(skills || []).join(" ")}`;
  const title = jobName || "";
  const aiSignal = /AI|人工智能|智能体|Agent|大模型|AIGC|LLM|AI平台|AI Agent|私有化|算力|企业AI|多模态|RAG|知识库|智能问答|机器学习|深度学习/.test(text);
  if (/销售|商务|BD|客户经理|渠道|市场推广|直播|电商运营/.test(title)) {
    return { role_fit: "低", role_note: "标题偏销售/商务/运营，当前不优先" };
  }
  if (/数据标注|标注团队|标注项目/.test(text) && !/智能体|Agent|大模型|AIGC|AI平台/.test(text)) {
    return { role_fit: "低", role_note: "偏数据标注方向，当前不优先" };
  }
  if (/智能体|Agent|大模型|AIGC|AI平台|AI Agent|私有化|算力|企业AI|多模态|RAG|知识库|智能问答/.test(text)) {
    return { role_fit: "高", role_note: "与AI智能体/AI平台/大模型落地强相关" };
  }
  if (aiSignal && /PMO|项目管理|项目经理|产品经理|交付|TPM|实施|解决方案/.test(text)) {
    return { role_fit: "中高", role_note: "与AI或项目/产品管理相关" };
  }
  return { role_fit: "低", role_note: "AI相关性不明显，按泛项目岗降级" };
}

function activityPriority(activeText, bossOnline) {
  const text = activeText || "";
  if (bossOnline === true || /刚刚|在线|今日|今天|活跃/.test(text)) {
    return { activity_priority: "高", activity_note: "发布人近期活跃" };
  }
  const day = text.match(/(\d+)\s*天/);
  if (day) {
    const n = Number(day[1]);
    if (n > 30) return { activity_priority: "不用考虑", activity_note: "超过一个月不活跃" };
    if (n > 14) return { activity_priority: "不太可行", activity_note: "超过两周不活跃" };
    if (n > 7) return { activity_priority: "低", activity_note: "超过一周不活跃" };
    return { activity_priority: "高", activity_note: "一周内活跃" };
  }
  return { activity_priority: "待判断", activity_note: "未捕获明确活跃文本" };
}

function overallPriority(parts) {
  if (parts.salary_priority === "暂不考虑") return "低";
  if (parts.role_fit === "低") return "低";
  if (parts.activity_priority === "不用考虑" || parts.activity_priority === "不太可行") return "低";
  if (parts.role_fit === "高" && parts.salary_priority === "保留" && parts.activity_priority === "高") return "高";
  if ((parts.role_fit === "高" || parts.role_fit === "中高") && parts.salary_priority === "保留") return "中高";
  return "中";
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== "") return obj[key];
  }
  return "";
}

function makeRecordKey(record) {
  if (record.job_id) return `boss:${record.job_id}`;
  const fallback = [record.company, record.job_title, record.salary, record.address].filter(Boolean).join("|");
  return `fallback:${fallback}`;
}

function keywordGroup(keyword) {
  return (keyword || "")
    .split(/[+＋,，、|｜\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function appendSearchOccurrence(record, strategyType, keyword) {
  let occurrences = [];
  try {
    occurrences = JSON.parse(record.search_occurrences_json || "[]");
  } catch {
    occurrences = [];
  }
  const occurrence = {
    strategy_type: strategyType || "",
    keyword,
    keyword_group: keywordGroup(keyword),
  };
  const seen = new Set(occurrences.map((item) => JSON.stringify(item)));
  const key = JSON.stringify(occurrence);
  if (!seen.has(key)) occurrences.push(occurrence);
  record.search_occurrences_json = JSON.stringify(occurrences);
  record.used_search_keyword_groups_json = JSON.stringify(
    [...new Map(occurrences.map((item) => [JSON.stringify(item.keyword_group), item.keyword_group])).values()]
  );
  record.search_strategy_types_json = JSON.stringify(
    [...new Set(occurrences.map((item) => item.strategy_type).filter(Boolean))]
  );
}

async function fetchList(ws, keyword, pageSize) {
  const expr = `(async () => {
    const params = new URLSearchParams({
      scene: '1',
      query: ${JSON.stringify(keyword)},
      city: '101020100',
      page: '1',
      pageSize: ${JSON.stringify(String(pageSize))}
    });
    const resp = await fetch('/wapi/zpgeek/search/joblist.json', {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: params.toString()
    });
    return { status: resp.status, text: await resp.text() };
  })()`;
  // `timeout` is not a CDP Runtime.evaluate parameter. Pass it to our
  // websocket wrapper so a slow BOSS response gets the intended budget.
  const result = await ws.cmd("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  }, 30000);
  const value = result.result.value;
  if (!value || value.status < 200 || value.status >= 300) {
    throw new Error(`BOSS job list HTTP status ${value?.status ?? "unknown"}`);
  }
  const json = parseJson(value.text);
  if (!json || json.code !== 0) {
    throw new Error(`BOSS job list business error: ${json?.code ?? "invalid_json"} ${json?.message || ""}`.trim());
  }
  const jobs = json?.zpData?.jobList || [];
  return { status: value.status, json, jobs };
}

async function searchUi(ws, keyword, firstJobName) {
  const expr = `(() => {
    const input = [...document.querySelectorAll('input')].find((el) => (el.placeholder || '').includes('搜索'));
    if (!input) return { ok: false, reason: 'search input not found' };
    input.focus();
    input.value = ${JSON.stringify(keyword)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    const buttons = [...document.querySelectorAll('button, a, div, span')].filter((el) => ((el.innerText || '').trim() === '搜索'));
    if (buttons[0]) buttons[0].click();
    return { ok: true, value: input.value, clickedButton: !!buttons[0] };
  })()`;
  const result = await ws.cmd("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  }, 15000);
  await sleep(8500);
  if (!firstJobName) return result.result.value;
  for (let i = 0; i < 8; i++) {
    const check = await ws.cmd("Runtime.evaluate", {
      expression: `(() => (document.body.innerText || '').includes(${JSON.stringify(firstJobName)}))()`,
      awaitPromise: true,
      returnByValue: true,
    }, 8000);
    if (check.result.value) return { ...(result.result.value || {}), firstJobVisible: true };
    await sleep(1000);
  }
  return { ...(result.result.value || {}), firstJobVisible: false };
}

async function captureDetailPageSnapshot(ws, maxAttempts = 3) {
  const params = {
    expression: `(() => ({ href: location.href, title: document.title, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 2000) }))()`,
    returnByValue: true,
    awaitPromise: true,
  };
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await ws.cmd("Runtime.evaluate", params, 25000);
      return { page: result.result?.value || {}, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await sleep(800 * attempt);
    }
  }
  return {
    page: {},
    attempts: maxAttempts,
    error: lastError?.message || "detail page snapshot failed",
  };
}

async function clickAndCapture(job, keyword, strategyType) {
  const { tab, ws } = await openWs();
  const captures = [];
  const requestUrls = new Map();

  ws.onEvent(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") {
      requestUrls.set(msg.params.requestId, msg.params.request.url);
      return;
    }
    if (msg.method !== "Network.responseReceived") return;
    const url = msg.params.response.url || requestUrls.get(msg.params.requestId) || "";
    if (!url.includes("/wapi/zpgeek/job/detail.json")) return;
    await sleep(300);
    try {
      const body = await ws.cmd("Network.getResponseBody", { requestId: msg.params.requestId });
      captures.push({ url, status: msg.params.response.status, json: parseJson(body.body || "") });
    } catch (err) {
      captures.push({ url, status: msg.params.response.status, error: err.message });
    }
  });

  const locateExpr = `(async () => {
    const needle = ${JSON.stringify(job.jobName)};
    const jobId = ${JSON.stringify(job.encryptJobId || "")};
    const securityId = ${JSON.stringify(job.securityId || "")};
    const norm = (s) => (s || '').replace(/\\s+/g, '').replace(/[（）()【】\\[\\]·\\-_/]/g, '').toLowerCase();
    const needleNorm = norm(needle);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const selector = 'a.job-name, .job-card-wrapper, [class*=job-card], a, li, div';
    const scrollTargets = () => {
      const els = [...document.querySelectorAll('div, ul, section, main')]
        .filter((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 80;
        })
        .sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth));
      return [els[0], document.scrollingElement].filter(Boolean);
    };
    for (const target of scrollTargets()) target.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(300);
    const find = () => {
      const candidates = [...document.querySelectorAll(selector)].map((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const href = el.getAttribute?.('href') || '';
        const html = el.outerHTML || '';
        const rect = el.getBoundingClientRect();
        const idHit = (jobId && (href.includes(jobId) || html.includes(jobId))) || (securityId && (href.includes(securityId) || html.includes(securityId)));
        const textHit = text.includes(needle) || norm(text).includes(needleNorm);
        return { el, text, href, rect, idHit, textHit };
      })
      .filter((x) => (x.idHit || x.textHit) && x.rect.width > 20 && x.rect.height > 10)
      .sort((a, b) => {
        if (a.idHit !== b.idHit) return a.idHit ? -1 : 1;
        return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
      });
      return candidates;
    };
    for (let step = 0; step < 10; step++) {
      const candidates = find();
      if (candidates[0]) {
        const picked = candidates[0];
        picked.el.scrollIntoView({ block: 'center', inline: 'nearest' });
        await sleep(200);
        const rect = picked.el.getBoundingClientRect();
        return {
          found: true,
          count: candidates.length,
          step,
          text: picked.text.slice(0, 500),
          href: picked.href,
          idHit: !!picked.idHit,
          x: rect.left + Math.min(rect.width / 2, 120),
          y: rect.top + rect.height / 2
        };
      }
      for (const target of scrollTargets()) target.scrollBy({ top: Math.round(window.innerHeight * 0.75), behavior: 'instant' });
      await sleep(450);
    }
    return { found: false, count: 0, needle, triedScroll: true, bodyText: (document.body.innerText || '').slice(0, 600) };
  })()`;
  let located;
  try {
    located = await ws.cmd(
      "Runtime.evaluate",
      {
        expression: locateExpr,
        returnByValue: true,
        awaitPromise: true,
      },
      12000
    );
  } catch (err) {
    ws.close();
    return { keyword, searchStrategyType: strategyType, listJob: job, error: "not_found_in_ui", locateError: err.message, captures: [], tab };
  }
  const loc = located.result?.value || {};
  if (!loc.found) {
    ws.close();
    return { keyword, searchStrategyType: strategyType, listJob: job, error: "not_found_in_ui", captures: [], tab };
  }

  await sleep(500);
  await ws.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: loc.x, y: loc.y, button: "none" });
  await sleep(140);
  await ws.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: loc.x, y: loc.y, button: "left", clickCount: 1 });
  await sleep(120);
  await ws.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: loc.x, y: loc.y, button: "left", clickCount: 1 });
  await sleep(4500);

  const snapshot = await captureDetailPageSnapshot(ws);
  await sleep(800);
  ws.close();
  return {
    keyword,
    searchStrategyType: strategyType,
    listJob: job,
    located: loc,
    captures,
    page: snapshot.page,
    pageSnapshotAttempts: snapshot.attempts,
    pageSnapshotError: snapshot.error,
    tab,
  };
}

function extractRecord(item) {
  const expectedId = item.listJob?.encryptJobId;
  const successCapture = item.captures?.find((cap) => {
    const captured = cap.json?.zpData?.jobInfo;
    const capturedId = captured?.encryptId || captured?.encryptJobId || "";
    return cap.json?.code === 0 && Boolean(expectedId) && capturedId === expectedId;
  });

  if (!successCapture) {
    const pageText = item.page?.text || "";
    const pageHasTarget = item.listJob?.jobName && pageText.includes(item.listJob.jobName);
    const district = item.listJob?.areaDistrict || inferShanghaiDistrict("", item.listJob?.cityName);
    const salary = parseSalary(item.listJob?.salaryDesc || "");
    const salPri = salaryPriority(salary.salary_min_k, salary.salary_max_k);
    const locPri = locationPriority(district);
    const fit = roleFit(item.listJob?.jobName, pageText, item.listJob?.skills || []);
    const bossOnline = item.listJob?.bossOnline ?? "";
    const activeText = bossOnline === true ? "在线" : "";
    const latestActiveDate = activeDateFromText(activeText, bossOnline);
    const activity = activityPriority(activeText, bossOnline);
    const priority = overallPriority({ ...salPri, ...fit, ...activity });
    const record = {
      search_strategy_type: item.searchStrategyType || "",
      keyword: item.keyword,
      collected_at: new Date().toISOString(),
      source: "BOSS直聘-CDP",
      company: item.listJob?.brandName || "",
      company_industry: item.listJob?.brandIndustry || "",
      company_scale: item.listJob?.brandScaleName || "",
      company_stage: item.listJob?.brandStageName || "",
      job_title: item.listJob?.jobName || "",
      salary: item.listJob?.salaryDesc || "",
      salary_min_k: salary.salary_min_k,
      salary_max_k: salary.salary_max_k,
      salary_months: salary.salary_months,
      city: item.listJob?.cityName || "",
      district,
      business_area: item.listJob?.businessDistrict || "",
      experience: item.listJob?.jobExperience || "",
      degree: item.listJob?.jobDegree || "",
      skills: item.listJob?.skills || [],
      welfare: item.listJob?.welfareList || [],
      job_description: pageHasTarget ? pageText : "",
      boss_name: item.listJob?.bossName || "",
      boss_title: item.listJob?.bossTitle || "",
      boss_active_text: activeText,
      latest_active_date: latestActiveDate,
      boss_online: bossOnline,
      job_id: item.listJob?.encryptJobId || "",
      security_id: item.listJob?.securityId || "",
      lid: item.listJob?.lid || "",
      location_priority: locPri.location_priority,
      salary_priority: salPri.salary_priority,
      role_fit: fit.role_fit,
      activity_priority: activity.activity_priority,
      overall_priority: priority,
      collection_status: item.error || (pageHasTarget ? "page_text_fallback" : "detail_not_captured"),
      notes: [
        pageHasTarget ? "详情接口未捕获，使用页面文本兜底" : "",
        locPri.location_note,
        salPri.salary_note,
        fit.role_note,
        activity.activity_note,
        item.captures?.map((cap) => cap.json?.message || cap.error).filter(Boolean).join("; "),
        item.pageSnapshotError ? `详情页面快照失败：${item.pageSnapshotError}` : "",
      ].filter(Boolean).join("；"),
    };
    record.record_key = makeRecordKey(record);
    appendSearchOccurrence(record, item.searchStrategyType, item.keyword);
    return record;
  }

  const z = successCapture.json.zpData;
  const job = z.jobInfo || {};
  const brand = z.brandComInfo || {};
  const boss = z.bossInfo || {};
  const district = pick(job, ["areaDistrict", "districtName"]) || inferShanghaiDistrict(job.address, job.locationName);
  const salary = parseSalary(job.salaryDesc);
  const salPri = salaryPriority(salary.salary_min_k, salary.salary_max_k);
  const locPri = locationPriority(district);
  const fit = roleFit(job.jobName, job.postDescription, job.showSkills || job.skills);
  const activeText = pick(boss, ["activeTimeDesc", "lastActiveTimeDesc", "onlineDesc", "activeDesc"]);
  const bossOnline = pick(boss, ["online", "bossOnline", "isOnline"]);
  const latestActiveDate = activeDateFromText(activeText, bossOnline);
  const activity = activityPriority(activeText, bossOnline);
  const priority = overallPriority({ ...salPri, ...fit, ...activity });

  const record = {
    search_strategy_type: item.searchStrategyType || "",
    keyword: item.keyword,
    collected_at: new Date().toISOString(),
    source: "BOSS直聘-CDP",
    company: pick(brand, ["brandName", "name"]) || pick(job, ["brandName"]) || item.listJob?.brandName || "",
    company_industry: pick(brand, ["industryName", "brandIndustry", "industry"]),
    company_scale: pick(brand, ["scaleName", "brandScaleName", "scale"]),
    company_stage: pick(brand, ["stageName", "brandStageName", "financeStageName"]),
    company_summary: pick(brand, ["brandIntroduce", "introduce", "summary"]),
    job_title: job.jobName,
    salary: job.salaryDesc,
    salary_min_k: salary.salary_min_k,
    salary_max_k: salary.salary_max_k,
    salary_months: salary.salary_months,
    city: pick(job, ["locationName", "cityName"]),
    district,
    business_area: pick(job, ["businessDistrict", "businessDistrictName"]),
    address: job.address,
    experience: job.experienceName,
    degree: job.degreeName,
    skills: job.showSkills || job.skills || [],
    welfare: pick(job, ["welfareList", "jobWelfareList"]) || [],
    job_description: job.postDescription,
    refresh_time: pick(job, ["refreshTimeDesc", "lastModifyTimeDesc", "jobRefreshTimeDesc", "updateTimeDesc"]),
    boss_name: pick(boss, ["name", "bossName"]) || item.listJob?.bossName || "",
    boss_title: pick(boss, ["title", "bossTitle"]) || item.listJob?.bossTitle || "",
    boss_id: pick(boss, ["encryptBossId", "encryptUserId", "bossId"]) || pick(job, ["encryptUserId"]),
    boss_active_text: activeText,
    latest_active_date: latestActiveDate,
    boss_online: bossOnline,
    job_id: pick(job, ["encryptId", "encryptJobId", "jobId"]) || item.listJob?.encryptJobId || "",
    security_id: z.securityId || item.listJob?.securityId || "",
    lid: z.lid || item.listJob?.lid || "",
    detail_url: successCapture.url,
    location_priority: locPri.location_priority,
    salary_priority: salPri.salary_priority,
    role_fit: fit.role_fit,
    activity_priority: activity.activity_priority,
    overall_priority: priority,
    notes: [locPri.location_note, salPri.salary_note, fit.role_note, activity.activity_note].filter(Boolean).join("；"),
    collection_status: "ok",
  };
  record.record_key = makeRecordKey(record);
  appendSearchOccurrence(record, item.searchStrategyType, item.keyword);
  return record;
}

const headers = [
  "record_key",
  "search_strategy_type",
  "search_strategy_types_json",
  "keyword",
  "used_search_keyword_groups_json",
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

const zhHeaders = {
  record_key: "去重键",
  search_strategy_type: "搜索策略类型",
  search_strategy_types_json: "搜索策略类型JSON",
  keyword: "搜索关键词",
  used_search_keyword_groups_json: "已用过搜索关键词组JSON",
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

function writeOutputs(payload) {
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  const lines = [
    headers.map((header) => csvCell(zhHeaders[header] || header)).join(","),
    headers.map(csvCell).join(","),
  ];
  for (const record of payload.records) {
    lines.push(headers.map((header) => csvCell(record[header])).join(","));
  }
  fs.writeFileSync(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");
}

async function main() {
  const seen = new Map();
  const rawItems = [];
  const records = [];
  const keywordStats = [];
  let partial = false;

  for (const spec of keywordSpecs) {
    if (records.length >= maxTotal) break;
    const { keyword, strategy_type: strategyType } = spec;
    let list;
    let jobs;
    let ui;
    let ws;
    try {
      ({ ws } = await openWs());
      list = await fetchList(ws, keyword, Math.max(perKeyword * 2, 20));
      jobs = (list.jobs || []).slice(0, perKeyword);
      ui = await searchUi(ws, keyword, jobs[0]?.jobName);
    } catch (err) {
      partial = true;
      keywordStats.push({ strategyType, keyword, collectionError: err.message, candidates: 0 });
      writeOutputs({ stageName, keywordSpecs, keywords, perKeyword, maxTotal, keywordStats, records, rawItems });
      console.error(JSON.stringify({ stageName, keyword, collectionError: err.message }));
      continue;
    } finally {
      ws?.close();
    }

    keywordStats.push({
      strategyType,
      keyword,
      listStatus: list.status,
      listCode: list.json?.code,
      listMessage: list.json?.message,
      resCount: list.json?.zpData?.resCount,
      candidates: jobs.length,
      ui,
    });

    for (const job of jobs) {
      if (records.length >= maxTotal) break;
      const key = job.encryptJobId ? `boss:${job.encryptJobId}` : `fallback:${job.brandName}|${job.jobName}|${job.salaryDesc}`;
      if (seen.has(key)) {
        appendSearchOccurrence(records[seen.get(key)], strategyType, keyword);
        writeOutputs({ stageName, keywordSpecs, keywords, perKeyword, maxTotal, keywordStats, records, rawItems });
        continue;
      }

      let raw;
      try {
        raw = await clickAndCapture(job, keyword, strategyType);
      } catch (err) {
        // One card must not make the whole batch unusable. extractRecord can
        // retain list-side fields and label this item for review.
        raw = {
          keyword,
          searchStrategyType: strategyType,
          listJob: job,
          captures: [],
          page: {},
          error: "detail_capture_failed",
          detailError: err.message,
        };
        console.error(JSON.stringify({ stageName, keyword, job: job.jobName, detailError: err.message }));
      }
      rawItems.push(raw);
      const record = extractRecord(raw);
      records.push(record);
      seen.set(key, records.length - 1);

      console.log(JSON.stringify({
        stageName,
        count: records.length,
        strategyType,
        keyword,
        job: record.job_title,
        company: record.company,
        status: record.collection_status,
        priority: record.overall_priority,
      }, null, 0));

      writeOutputs({ stageName, keywordSpecs, keywords, perKeyword, maxTotal, keywordStats, records, rawItems });
      await sleep(3500 + Math.floor(Math.random() * 2500));
    }
  }

  const payload = { stageName, keywordSpecs, keywords, perKeyword, maxTotal, keywordStats, records, rawItems, complete: true, partial };
  writeOutputs(payload);
  console.log(JSON.stringify({ csvPath, jsonPath, total: records.length, keywordStats }, null, 2));
  if (partial) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

module.exports = { captureDetailPageSnapshot };
