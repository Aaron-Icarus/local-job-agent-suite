const { loadEnv } = require("../../core/load_env");

loadEnv();

const targetUrl = process.env.BOSS_LOGIN_CHECK_URL || "https://www.zhipin.com/web/geek/jobs";
const args = new Set(process.argv.slice(2));
const useNewTab = args.has("--new");
const cdpHost = process.env.CDP_HOST || "127.0.0.1";
const cdpPort = process.env.CDP_PORT || "9222";
const cdpBaseUrl = process.env.CDP_BASE_URL || `http://${cdpHost}:${cdpPort}`;

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method}`));
            }
          }, 8000);
        });
      },
      close() {
        ws.close();
      }
    });
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
  });
}

async function findOrCreateTab() {
  if (useNewTab) {
    const encoded = encodeURIComponent(targetUrl);
    return getJson(`${cdpBaseUrl}/json/new?${encoded}`, { method: "PUT" });
  }
  const tabs = await getJson(`${cdpBaseUrl}/json/list`);
  const existing = tabs.find((tab) => tab.type === "page" && tab.webSocketDebuggerUrl && (tab.url || "").includes("zhipin.com"));
  if (existing) {
    await fetch(`${cdpBaseUrl}/json/activate/${existing.id}`).catch(() => {});
    const refreshed = await getJson(`${cdpBaseUrl}/json/list`).catch(() => []);
    return refreshed.find((tab) => tab.id === existing.id) || existing;
  }
  const encoded = encodeURIComponent(targetUrl);
  return getJson(`${cdpBaseUrl}/json/new?${encoded}`, { method: "PUT" });
}

function classify({ href, text }) {
  const combined = `${href}\n${text}`;
  if (/安全验证|环境异常|verify|_security_check/.test(combined)) return "security_check";
  if (/passport|扫码登录|请登录|登录后|验证码/.test(combined) && !/消息|简历|沟通/.test(text)) return "login_required";
  if (/职位|搜索职位|薪资待遇|工作经验/.test(text) && /消息|简历|沟通|收藏/.test(text)) return "logged_in";
  return "unknown";
}

function classifyValue(value) {
  if (value.hasSecurityText) return "security_check";
  if (value.hasLoginText && !value.hasUserArea) return "login_required";
  if (value.hasJobShell && value.hasUserArea) return "logged_in";
  return classify({ href: value.href || "", text: value.sample || "" });
}

async function main() {
  const tab = await findOrCreateTab();
  await sleep(useNewTab ? 6000 : 2000);
  const freshTabs = await getJson(`${cdpBaseUrl}/json/list`);
  const freshTab = freshTabs.find((item) => item.id === tab.id) || tab;
  const client = await cdp(freshTab.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    const expr = `(() => {
      const text = document.body ? document.body.innerText : "";
      return {
        title: document.title,
        href: location.href,
        textLength: text.length,
        hasUserArea: /消息|简历|沟通|收藏/.test(text),
        hasJobShell: /职位|搜索职位|薪资待遇|工作经验/.test(text),
        hasLoginText: /扫码登录|请登录|登录后|验证码/.test(text),
        hasSecurityText: /安全验证|环境异常|verify|_security_check/.test(text + location.href),
        sample: text.slice(0, 300)
      };
    })()`;
    const result = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    const value = result.result.value;
    const loginStatus = classifyValue(value);
    console.log(JSON.stringify({ loginStatus, tabId: freshTab.id, ...value }, null, 2));
    if (loginStatus !== "logged_in") process.exitCode = 2;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
