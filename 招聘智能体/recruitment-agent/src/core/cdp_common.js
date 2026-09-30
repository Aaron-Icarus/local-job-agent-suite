const fs = require("fs");
const path = require("path");

function buildSharePackageCommand(relativeScript) {
  const path = require("path");
  const recruitmentRoot = path.resolve(__dirname, "..", "..");
  const packageRoot = path.resolve(recruitmentRoot, "..", "..");
  const safeRoot = packageRoot.replace(/'/g, "''");
  const safeRelative = String(relativeScript || "").replace(/'/g, "''");
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '${safeRoot}'; & '${safeRelative}'"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (error) {
    if (/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/json/i.test(url)) {
      const bossLoginCommand = buildSharePackageCommand(".\\快捷启动\\快捷启动脚本\\open_boss_login.ps1");
      const scheduledCommand = buildSharePackageCommand(".\\快捷启动\\快捷启动脚本\\run_scheduled.ps1");
      throw new Error(
        `无法连接本机 Chrome CDP：${url}。如需人工登录/安全验证，请复制运行：${bossLoginCommand}。如需让定时入口自动拉起 CDP，请复制运行：${scheduledCommand}。原始错误：${error.message}`
      );
    }
    throw error;
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function cdpBaseUrl() {
  const host = process.env.CDP_HOST || "127.0.0.1";
  const port = process.env.CDP_PORT || "9222";
  return process.env.CDP_BASE_URL || `http://${host}:${port}`;
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

async function findOrCreateTab(matchUrl, targetUrl) {
  const base = cdpBaseUrl();
  const tabs = await getJson(`${base}/json/list`);
  const existing = tabs.find((tab) => tab.type === "page" && tab.webSocketDebuggerUrl && matchUrl(tab.url || ""));
  if (existing) return existing;
  return getJson(`${base}/json/new?${targetUrl}`, { method: "PUT" });
}

// 采集标签隔离：只复用"采集自己创建的标签"，绝不复用用户手动打开的标签。
// 采集创建的 tabId 记录在 data/collect_tabs.json（按平台分开），跨轮次复用。
function collectTabsPath() {
  return path.resolve(__dirname, "..", "..", "data", "collect_tabs.json");
}

function readCollectTabs() {
  try {
    return JSON.parse(fs.readFileSync(collectTabsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeCollectTabs(tabs) {
  try {
    const filePath = collectTabsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tabs, null, 2), "utf8");
  } catch {
    // 记录失败不影响本轮采集
  }
}

async function findOrCreateCollectTab(purpose, targetUrl, options = {}) {
  const base = cdpBaseUrl();
  const tracked = readCollectTabs();
  const trackedId = tracked[purpose];
  if (trackedId && !options.force) {
    const tabs = await getJson(`${base}/json/list`);
    const existing = tabs.find((tab) => tab.id === trackedId && tab.type === "page" && tab.webSocketDebuggerUrl);
    if (existing && (!options.isUsable || options.isUsable(existing))) return existing;
  }
  const created = await getJson(`${base}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  const updated = readCollectTabs();
  updated[purpose] = created.id;
  writeCollectTabs(updated);
  return created;
}

// 采集结束后关闭"采集自己创建的标签"，保持浏览器整洁；绝不动用户手动打开的标签。
async function closeCollectTabs(purposes = ["boss", "liepin"]) {
  const base = cdpBaseUrl();
  const tracked = readCollectTabs();
  let tabs = [];
  try {
    tabs = await getJson(`${base}/json/list`);
  } catch {
    tabs = [];
  }
  const closed = [];
  for (const purpose of purposes) {
    const id = tracked[purpose];
    if (!id) continue;
    if (tabs.some((tab) => tab.id === id)) {
      await fetch(`${base}/json/close/${id}`).catch(() => {});
      closed.push(purpose);
    }
    delete tracked[purpose];
  }
  writeCollectTabs(tracked);
  return closed;
}

async function openWsForTab(tab) {
  const ws = connect(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  // 注意：这里**不能**调用 Runtime.enable。
  // BOSS 招聘页存在反调试逻辑：一旦开启 Runtime 域，之后带 awaitPromise 的
  // Runtime.evaluate 会被页面挂住永不返回（实测同一条请求：不开域 348ms 成功，
  // 只开 Runtime 域 20s 超时），BOSS 登录检查就会拿到 Failed to fetch。
  // 本模块只用到 Runtime.evaluate / Page.navigate，均不需要开启任何域。
  // await ws.cmd("Runtime.enable");
  await ws.cmd("Page.enable");
  await ws.cmd("Network.enable");
  return ws;
}

async function navigate(ws, url, waitMs = 5000) {
  await ws.cmd("Page.navigate", { url }, 15000);
  const deadline = Date.now() + waitMs;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const value = await evaluate(ws, "location.href", 3000);
      last = value || "";
      if (last && last !== "about:blank") return last;
    } catch {
      // Keep waiting through transient navigation states.
    }
  }
  return last;
}

async function evaluate(ws, expression, timeoutMs = 15000) {
  const result = await ws.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  return result.result.value;
}

module.exports = { sleep, getJson, cdpBaseUrl, findOrCreateTab, findOrCreateCollectTab, closeCollectTabs, readCollectTabs, writeCollectTabs, openWsForTab, navigate, evaluate };
