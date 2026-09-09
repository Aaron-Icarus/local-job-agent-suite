const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const packageRoot = path.resolve(__dirname, "..", "..");
const dashboardPath = path.join(packageRoot, "快捷启动", "页面UI", "index.html");
const host = "127.0.0.1";
const port = Number(process.env.LOCAL_DASHBOARD_PORT || 17321);
const recruitmentRoot = path.join(packageRoot, "招聘智能体", "recruitment-agent");
const { loadChannelConfig, saveChannelConfig, knownPlatforms } = require(path.join(recruitmentRoot, "src", "core", "channel_config"));
const { loadSchedulePolicy } = require(path.join(recruitmentRoot, "src", "core", "schedule_policy"));

const folderTargets = {
  package_root: { label: "分享包根目录", path: packageRoot },
  recruitment_agent: { label: "招聘 Agent 项目", path: path.join(packageRoot, "招聘智能体", "recruitment-agent") },
  message_platform: { label: "消息平台项目", path: path.join(packageRoot, "消息平台", "message-platform") },
  prd: { label: "PRD 目录", path: path.join(packageRoot, "docs", "prd") },
  launcher: { label: "快捷启动目录", path: path.join(packageRoot, "快捷启动") },
  launcher_scripts: { label: "快捷启动脚本", path: path.join(packageRoot, "快捷启动", "快捷启动脚本") },
  packages: { label: "随项目必须的安装包", path: path.join(packageRoot, "快捷启动", "随项目必须的安装包") },
  ui: { label: "页面 UI 目录", path: path.join(packageRoot, "快捷启动", "页面UI") },
  candidate_profiles: { label: "候选人画像 Md 文件夹", path: path.join(packageRoot, "招聘智能体", "recruitment-agent", "config", "candidate_profiles") },
  recruitment_config: { label: "招聘 Agent 配置目录", path: path.join(packageRoot, "招聘智能体", "recruitment-agent", "config") },
  recruitment_outputs: { label: "招聘 Agent outputs", path: path.join(packageRoot, "招聘智能体", "recruitment-agent", "outputs") },
  recruitment_logs: { label: "招聘 Agent logs", path: path.join(packageRoot, "招聘智能体", "recruitment-agent", "logs") },
  message_config: { label: "消息平台配置目录", path: path.join(packageRoot, "消息平台", "message-platform", "config") },
  message_logs: { label: "消息平台 logs", path: path.join(packageRoot, "消息平台", "message-platform", "logs") },
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) reject(new Error("请求内容过大。"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(text || "{}")); } catch { reject(new Error("请求不是有效 JSON。")); }
    });
    req.on("error", reject);
  });
}

function trustedLocalOrigin(req) {
  const origin = String(req.headers.origin || "");
  return !origin || origin === "null" || origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

function ensureInsidePackage(targetPath) {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(packageRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("目标目录不在分享包目录内，已拒绝打开。");
  }
  return resolved;
}

function openFolder(targetPath) {
  const resolved = ensureInsidePackage(targetPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`目录不存在：${resolved}`);
  }
  const child = spawn("explorer.exe", [resolved], { detached: true, stdio: "ignore" });
  child.unref();
  return resolved;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${host}:${port}`);

  if (!trustedLocalOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "只允许本地控制台页面修改配置。" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      sendText(res, 200, fs.readFileSync(dashboardPath, "utf8"), "text/html; charset=utf-8");
    } catch (error) {
      sendText(res, 500, error.message || String(error));
    }
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, packageRoot, targets: Object.keys(folderTargets) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/platforms") {
    try {
      const result = loadChannelConfig();
      sendJson(res, 200, { ok: true, filePath: result.filePath, platforms: result.config.platforms });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/platforms/")) {
    const platform = decodeURIComponent(url.pathname.slice("/api/platforms/".length)).toLowerCase();
    if (!knownPlatforms.includes(platform)) {
      sendJson(res, 404, { ok: false, error: `未知招聘平台：${platform}` });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = loadChannelConfig();
      if (typeof body.enabled === "boolean") result.config.platforms[platform].enabled = body.enabled;
      if (typeof body.detail_capture === "boolean") result.config.platforms[platform].detail_capture = body.detail_capture;
      saveChannelConfig(result.config, result.filePath);
      sendJson(res, 200, { ok: true, platform, value: result.config.platforms[platform], filePath: result.filePath });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/schedule") {
    try {
      const result = loadSchedulePolicy();
      sendJson(res, 200, { ok: true, filePath: result.filePath, policy: result.policy });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (url.pathname === "/open-folder") {
    const target = url.searchParams.get("target") || "";
    const dryRun = url.searchParams.get("dryRun") === "1";
    const item = folderTargets[target];
    if (!item) {
      sendJson(res, 404, { ok: false, error: "未知目录。只允许打开白名单目录。", allowedTargets: Object.keys(folderTargets) });
      return;
    }
    try {
      const resolved = ensureInsidePackage(item.path);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`目录不存在：${resolved}`);
      }
      if (!dryRun) openFolder(resolved);
      sendJson(res, 200, { ok: true, target, label: item.label, path: resolved, dryRun });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(port, host, () => {
  console.log(`分享包本地控制台 helper 已启动：http://${host}:${port}/`);
  console.log(`页面文件：${dashboardPath}`);
  console.log("按 Ctrl+C 可停止 helper。");
});
