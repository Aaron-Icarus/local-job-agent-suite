const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_CDP_PORT = 9222;
const MAX_CDP_PORT = 9322;
const PORT_STATE_PATH = path.resolve(__dirname, "..", "..", "data", "cdp.json");

const COMMON_PATHS = [
  process.env.V14_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  path.join(process.env.HOME || "", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
];

function defaultProfileDir() {
  if (process.env.V14_CHROME_PROFILE) return path.resolve(process.env.V14_CHROME_PROFILE);
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || "", "Library", "Application Support", "JobAgent", "ChromeProfile");
  }
  return path.join(process.env.LOCALAPPDATA || "", "JobAgent", "ChromeProfile");
}

function findChrome() {
  for (const item of COMMON_PATHS) {
    if (item && fs.existsSync(item)) return item;
  }
  return "";
}

function buildChromeArgs(input = {}) {
  const profileDir = input.profileDir || defaultProfileDir();
  const port = Number(input.port || process.env.CDP_PORT || DEFAULT_CDP_PORT);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];
  if (input.startMinimized !== false) args.push("--start-minimized");
  if (input.startUrl) args.push(input.startUrl);
  return args;
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function isCdpReady(port, timeoutMs = 900) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data && data.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

function readSavedPort() {
  try {
    const data = JSON.parse(fs.readFileSync(PORT_STATE_PATH, "utf8"));
    return Number(data.port || 0);
  } catch {
    return 0;
  }
}

function savePort(port) {
  try {
    fs.mkdirSync(path.dirname(PORT_STATE_PATH), { recursive: true });
    fs.writeFileSync(PORT_STATE_PATH, JSON.stringify({ port: Number(port), updated_at: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    // 端口状态写不进去时仍以进程环境变量为准
  }
}

async function findAvailablePort(start = DEFAULT_CDP_PORT) {
  for (let port = Number(start); port <= MAX_CDP_PORT; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`找不到可用的 Chrome 调试端口（${start}-${MAX_CDP_PORT}）`);
}

async function resolveCdpPort(preferred) {
  const requested = Number(preferred || process.env.CDP_PORT || readSavedPort() || DEFAULT_CDP_PORT);
  if (await isCdpReady(requested)) return { port: requested, reused: true, conflict: false };
  if (await isPortOpen(requested)) {
    const port = await findAvailablePort(requested + 1);
    savePort(port);
    process.env.CDP_PORT = String(port);
    return { port, reused: false, conflict: true, occupiedPort: requested };
  }
  savePort(requested);
  process.env.CDP_PORT = String(requested);
  return { port: requested, reused: false, conflict: false };
}

async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureChrome(input = {}) {
  const resolved = await resolveCdpPort(input.port);
  if (resolved.reused || await isCdpReady(resolved.port)) {
    return { ...resolved, chromePath: input.chromePath || findChrome(), child: null };
  }
  const chromePath = input.chromePath || findChrome();
  if (!chromePath) throw new Error("未找到 Google Chrome，请先安装或设置 V14_CHROME_PATH");
  const started = startChrome({ ...input, port: resolved.port, startUrl: input.startUrl || "about:blank" });
  const ready = await waitForCdp(resolved.port, Number(input.timeoutMs || 15000));
  if (!ready) {
    try { started.child.kill(); } catch { /* ignore */ }
    throw new Error(`Chrome 已启动但 CDP 端口 ${resolved.port} 未就绪，请检查是否被安全软件拦截`);
  }
  return { ...resolved, chromePath, child: started.child };
}

function startChrome(input = {}) {
  const chromePath = input.chromePath || findChrome();
  if (!chromePath) throw new Error("未找到 Google Chrome，请先安装或设置 V14_CHROME_PATH");
  const args = buildChromeArgs(input);
  const child = spawn(chromePath, args, {
    detached: false,
    windowsHide: false,
    stdio: "ignore",
  });
  return { child, chromePath, args };
}

function stopChrome(child) {
  if (!child || child.killed) return false;
  child.kill();
  return true;
}

module.exports = {
  COMMON_PATHS,
  DEFAULT_CDP_PORT,
  PORT_STATE_PATH,
  findChrome,
  buildChromeArgs,
  isPortOpen,
  isCdpReady,
  resolveCdpPort,
  ensureChrome,
  startChrome,
  stopChrome,
};
