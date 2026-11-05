const path = require("path");
const { spawn } = require("child_process");

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

function checkPlatform(platform, options = {}) {
  const script = SCRIPTS[platform];
  if (!script) return Promise.resolve({ ok: false, status: "unknown", error: "未知平台" });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.join(__dirname, "..", ".."),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      const result = parseLastJson(stdout);
      const status = result?.loginStatus || "unknown";
      resolve({
        ok: status === "logged_in",
        status,
        code,
        stderr: stderr.slice(-1000),
        detail: result || null,
      });
    });
  });
}

module.exports = { SCRIPTS, parseLastJson, checkPlatform };
