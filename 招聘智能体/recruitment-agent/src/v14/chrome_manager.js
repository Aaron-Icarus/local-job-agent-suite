const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const COMMON_PATHS = [
  process.env.V14_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];

function findChrome() {
  for (const item of COMMON_PATHS) {
    if (item && fs.existsSync(item)) return item;
  }
  return "";
}

function buildChromeArgs(input = {}) {
  const profileDir = input.profileDir || path.join(process.env.LOCALAPPDATA || "", "JobAgent", "ChromeProfile");
  const port = Number(input.port || 9222);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--start-minimized",
  ];
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

module.exports = { COMMON_PATHS, findChrome, buildChromeArgs, isPortOpen, startChrome, stopChrome };
