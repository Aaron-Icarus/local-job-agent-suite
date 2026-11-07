const path = require("path");
const { spawn } = require("child_process");
const { ensureChrome, closeChrome, minimizeChrome } = require("./chrome_manager");

const SCRIPTS = {
  BOSS: path.join(__dirname, "..", "platforms", "boss", "check_boss_login_status.js"),
  "猎聘": path.join(__dirname, "..", "platforms", "liepin", "check_liepin_login_status.js"),
};

function parseLastJson(text) {
  const source = String(text || "").trim();
  for (let index = source.lastIndexOf("{"); index >= 0; index = source.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(source.slice(index));
    } catch {
      // keep looking
    }
  }
  return null;
}

async function closeChromeIfDetectionOnly(chrome) {
  if (!chrome || !chrome.child || chrome.reused) return;
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    const response = await fetch(`http://127.0.0.1:${chrome.port}/json/list`, { signal: AbortSignal.timeout(1200) });
    const tabs = await response.json();
    const realPages = tabs.filter((tab) => tab.type === "page" && tab.url && tab.url !== "about:blank");
    if (!realPages.length) {
      const closed = await closeChrome(chrome.port);
      if (!closed) chrome.child.kill();
    }
  } catch {
    // 清理失败不影响登录结果
  }
}

async function checkPlatform(platform, options = {}) {
  const script = SCRIPTS[platform];
  if (!script) return { ok: false, status: "unknown", error: "未知平台" };
  let chrome = null;
  try {
    chrome = await ensureChrome({ startMinimized: true, startUrl: "about:blank" });
  } catch (error) {
    return { ok: false, status: "browser_error", error: `无法启动 Chrome：${error.message}` };
  }
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.join(__dirname, "..", ".."),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!chrome.reused) {
      setTimeout(() => minimizeChrome(chrome.port).catch(() => {}), 1200);
      setTimeout(() => minimizeChrome(chrome.port).catch(() => {}), 3200);
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, status: "timeout", error: "登录检查超时" });
    }, Number(options.timeoutMs || 35000));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: "error", error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseLastJson(stdout);
      const status = parsed?.loginStatus || "unknown";
      resolve({
        ok: status === "logged_in",
        status,
        code,
        stderr: stderr.slice(-1000),
        detail: parsed || null,
      });
    });
  });
  if (result.ok) await closeChromeIfDetectionOnly(chrome);
  return result;
}

module.exports = { SCRIPTS, parseLastJson, checkPlatform };
