const { loadEnv } = require("../../core/load_env");
const { cdpBaseUrl, getJson, sleep, openWsForTab, evaluate, findOrCreateCollectTab } = require("../../core/cdp_common");

loadEnv();

const targetUrl = process.env.BOSS_LOGIN_CHECK_URL || "https://www.zhipin.com/web/geek/jobs";
const args = new Set(process.argv.slice(2));
const useNewTab = args.has("--new");
const stableJobsRe = /https?:\/\/www\.zhipin\.com\/web\/geek\/jobs/i;

function bossTab(tab) {
  return tab.type === "page" && tab.webSocketDebuggerUrl && /zhipin\.com/.test(tab.url || "");
}

function bossTabScore(tab) {
  if (!bossTab(tab)) return -1000;
  const url = tab.url || "";
  const title = tab.title || "";
  let score = 0;
  if (stableJobsRe.test(url)) score += 100;
  if (/\/job_detail\//i.test(url)) score += 40;
  if (/www\.zhipin\.com/i.test(url)) score += 20;
  if (/passport|login|_security_check|verify|captcha/i.test(url + title)) score -= 100;
  if (/加载中|请稍候|loading/i.test(title)) score -= 30;
  if (url === "about:blank") score -= 100;
  return score;
}

function isUnstableBossTab(tab) {
  const text = `${tab?.url || ""}\n${tab?.title || ""}`;
  return /加载中|请稍候|loading|passport|login|_security_check|verify|captcha/i.test(text);
}

async function findCurrentBossTab(base, preferredId = "") {
  const tabs = await getJson(`${base}/json/list`);
  if (preferredId) {
    const preferred = tabs.find((tab) => tab.id === preferredId && bossTab(tab));
    if (preferred) return preferred;
  }
  const candidates = tabs.filter(bossTab).sort((a, b) => bossTabScore(b) - bossTabScore(a));
  return candidates[0] || null;
}

async function activateTab(base, tab) {
  // 后台采集模式：不再激活标签页/窗口（避免窗口弹出到前台）。
  // CDP Runtime.evaluate 无需激活也能工作。
  return;
}

async function createStableTab(base) {
  const encoded = encodeURIComponent(targetUrl);
  return getJson(`${base}/json/new?${encoded}`, { method: "PUT" });
}

async function findOrCreateTab(base) {
  // 标签隔离：只复用采集自己创建的标签，不复用用户手动打开的标签。
  return findOrCreateCollectTab("boss", targetUrl, { force: useNewTab, isUsable: (t) => !isUnstableBossTab(t) });
}

function classify({ href, text }) {
  const combined = `${href}\n${text}`;
  if (/安全验证|环境异常|verify|_security_check/.test(combined)) return "security_check";
  if (/登录\/注册|登录注册|passport|扫码登录|请登录|登录后|验证码/.test(combined) && !/消息|简历|沟通/.test(text)) return "login_required";
  if (/职位|搜索职位|薪资待遇|工作经验/.test(text) && /消息|简历|沟通|收藏/.test(text)) return "logged_in";
  return "unknown";
}

function classifyValue(value) {
  if (!value) return "unknown";
  if (value.hasSecurityText) return "security_check";
  if (value.hasLoginEntry) return "login_required";
  if (value.hasLoginText && !value.hasUserArea) return "login_required";
  if (value.hasJobShell && value.hasUserArea) return "logged_in";
  return classify({ href: value.href || "", text: value.sample || "" });
}

function classifyApiProbe(probe) {
  if (!probe) return "";
  const code = Number(probe.apiCode);
  const text = `${probe.apiMessage || ""}\n${probe.rawSample || ""}`;
  if ([37, 38].includes(code) || /环境存在异常|安全验证|verify|captcha|验证码/i.test(text)) return "security_check";
  if (/请登录|登录后|未登录|passport|扫码登录/i.test(text)) return "login_required";
  if (probe.apiStatus >= 200 && probe.apiStatus < 300 && code === 0 && (probe.hasJobList || Number.isFinite(Number(probe.resCount)))) return "logged_in";
  return "";
}

// 组合判定。历史上只要 API 侧判为 logged_in 就无条件覆盖 DOM 侧的 login_required，
// 而 BOSS 的搜索接口对"匿名/被风控降级"的请求同样返回 code:0 + 有效 jobList，
// 于是页面明明显示"登录/注册"也能通过校验，采集照跑，最终产出整批无薪资的废数据
// （2026-09-30 空推送的直接上游原因）。
// 修正：DOM 明确给出否定信号（login_required / security_check）时，API 必须同时给出
// "只有登录态才会有"的证据（返回岗位且带薪资）才可判为已登录。
function combineStatus(domStatus, apiStatus, apiHasSalary = true) {
  if (apiStatus === "security_check") return apiStatus;
  if (["security_check", "login_required"].includes(domStatus) && !apiHasSalary) return domStatus;
  if (apiStatus === "logged_in" || domStatus === "logged_in") return "logged_in";
  if (["security_check", "login_required"].includes(apiStatus)) return apiStatus;
  if (["security_check", "login_required"].includes(domStatus)) return domStatus;
  return domStatus || apiStatus || "unknown";
}

async function inspectDom(tab) {
  const expr = `(() => {
    const text = document.body ? document.body.innerText : "";
    return {
      title: document.title,
      href: location.href,
      textLength: text.length,
      hasUserArea: /消息|简历|沟通|收藏/.test(text),
      hasJobShell: /职位|搜索职位|薪资待遇|工作经验/.test(text),
      hasLoginText: /扫码登录|请登录|登录后|验证码/.test(text),
      hasLoginEntry: /登录\\/注册|登录注册/.test(text),
      hasSecurityText: /安全验证|环境异常|verify|_security_check/.test(text + location.href),
      sample: text.slice(0, 300)
    };
  })()`;
  const ws = await openWsForTab(tab);
  try {
    return await evaluate(ws, expr, 30000);
  } finally {
    ws.close();
  }
}

async function inspectApi(tab) {
  const expr = `(async () => {
    try {
      const params = new URLSearchParams({ scene: '1', query: 'AI项目经理', city: '101020100', page: '1', pageSize: '3' });
      const resp = await fetch('/wapi/zpgeek/search/joblist.json', {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: params.toString()
      });
      const raw = await resp.text();
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      return {
        ok: true,
        apiStatus: resp.status,
        apiCode: json && json.code,
        apiMessage: (json && json.message) || "",
        hasJobList: Array.isArray(json && json.zpData && json.zpData.jobList),
        // 登录态强证据：BOSS 对匿名/被风控降级的请求同样返回 code:0 + jobList，
        // 但会把 salaryDesc 抹空。有薪资才说明这次请求确实带着有效登录态。
        hasSalary: Array.isArray(json && json.zpData && json.zpData.jobList)
          && json.zpData.jobList.some((item) => item && String(item.salaryDesc || "").trim() !== ""),
        resCount: json && json.zpData && json.zpData.resCount,
        rawSample: raw.slice(0, 180)
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  })()`;
  const ws = await openWsForTab(tab);
  try {
    return await evaluate(ws, expr, 30000);
  } finally {
    ws.close();
  }
}

async function retryProbe(base, initialTab, probe) {
  let tab = initialTab;
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await sleep(2000);
      tab = await findCurrentBossTab(base, tab.id) || tab;
    }
    try {
      const value = await probe(tab);
      if (value) return { value, tab };
    } catch (error) {
      lastError = error.message;
      if (!/navigated|closed|timeout|WebSocket/i.test(lastError)) break;
    }
  }
  return { value: null, tab, error: lastError || "probe returned no value" };
}

async function main() {
  const base = cdpBaseUrl();
  let tab = await findOrCreateTab(base);
  await sleep(useNewTab ? 8000 : 3000);
  tab = await findCurrentBossTab(base, tab.id) || tab;

  const domProbe = await retryProbe(base, tab, inspectDom);
  tab = domProbe.tab;
  const apiProbe = await retryProbe(base, tab, inspectApi);
  tab = apiProbe.tab;

  const value = domProbe.value || {
    title: tab.title || "",
    href: tab.url || "",
    textLength: 0,
    hasUserArea: false,
    hasJobShell: false,
    hasLoginText: false,
    hasLoginEntry: false,
    hasSecurityText: false,
    sample: "",
    domProbeError: domProbe.error || "Runtime.evaluate returned no value"
  };
  const apiValue = apiProbe.value || { ok: false, error: apiProbe.error || "api probe returned no value" };
  const domStatus = classifyValue(value);
  const apiStatus = classifyApiProbe(apiValue);
  const apiHasSalary = apiValue && apiValue.hasSalary === true;
  const loginStatus = combineStatus(domStatus, apiStatus, apiHasSalary);
  console.log(JSON.stringify({ loginStatus, domStatus, apiStatus, apiHasSalary, tabScore: bossTabScore(tab), tabId: tab.id, ...value, apiProbe: apiValue }, null, 2));
  if (loginStatus !== "logged_in") process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { classify, classifyValue, classifyApiProbe, combineStatus, bossTabScore, isUnstableBossTab, findCurrentBossTab };
