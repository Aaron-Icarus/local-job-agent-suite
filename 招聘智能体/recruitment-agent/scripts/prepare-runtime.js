const fs = require("fs");
const path = require("path");

const appRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(appRoot, "..", "..");
const buildRoot = path.join(appRoot, "build", "runtime");
const messageSource = path.join(projectRoot, "消息平台", "message-platform");
const messageTarget = path.join(buildRoot, "message-platform");

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(source, target, options = {}) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (options.exclude?.includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to, options);
    else fs.copyFileSync(from, to);
  }
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

resetDir(buildRoot);
for (const dir of ["src", "ui", "skills", "config"]) {
  copyDir(path.join(appRoot, dir), path.join(buildRoot, dir), {
    exclude: ["data", "logs", "tests", "node_modules"],
  });
}

const nodeName = process.platform === "win32" ? "node.exe" : "node";
copyFile(process.execPath, path.join(buildRoot, nodeName));

// 消息平台作为独立子服务随安装包分发；配置使用安全空白值，真实 .env 不进入安装包。
for (const dir of ["src", "config", "prompts", "ui", "node_modules", "vendor"]) {
  copyDir(path.join(messageSource, dir), path.join(messageTarget, dir), {
    exclude: ["data", "logs", "tests", ".env"],
  });
}
for (const file of ["package.json", "package-lock.json", "agents.config.json", "runtime.config.json", "channels.config.json", "routes.config.json"]) {
  const source = path.join(messageSource, file);
  if (fs.existsSync(source)) copyFile(source, path.join(messageTarget, file));
}

safeJson(path.join(messageTarget, "agents.config.json"), (data) => {
  for (const agent of data.agents || []) {
    if (agent.agent_id === "local_chat_agent" && agent.executor_config) {
      agent.executor_config.base_url = "";
    }
  }
  return data;
});

function safeJson(file, transform) {
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify(transform(data), null, 2), "utf8");
}

safeJson(path.join(messageTarget, "channels.config.json"), (data) => {
  for (const channel of data.channels || []) {
    channel.enabled = false;
    channel.allowed_chat_ids = ["oc_placeholder"];
  }
  return data;
});
safeJson(path.join(messageTarget, "routes.config.json"), (data) => {
  for (const conversation of data.conversations || []) {
    conversation.enabled = false;
    conversation.chat_id = "oc_placeholder";
    conversation.default_agent_id = "local_chat_agent";
  }
  return data;
});
safeJson(path.join(messageTarget, "runtime.config.json"), (data) => {
  data.env_files = [".env"];
  return data;
});

const summary = {
  ok: true,
  platform: process.platform,
  arch: process.arch,
  runtime: buildRoot,
  node: path.join(buildRoot, nodeName),
  messagePlatform: messageTarget,
};
console.log(JSON.stringify(summary, null, 2));
