function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
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

async function openWsForTab(tab) {
  const ws = connect(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await ws.cmd("Runtime.enable");
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

module.exports = { sleep, getJson, cdpBaseUrl, findOrCreateTab, openWsForTab, navigate, evaluate };
