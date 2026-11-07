const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PLATFORM_DIR = path.resolve(__dirname, "..", "..", "..", "..", "消息平台", "message-platform");
const ENV_FILE = path.join(PLATFORM_DIR, ".env");
const CHANNELS_FILE = path.join(PLATFORM_DIR, "channels.config.json");
const ROUTES_FILE = path.join(PLATFORM_DIR, "routes.config.json");
const LOG_DIR = path.join(PLATFORM_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "service.log");

let child = null;
let startedAt = "";
let lastError = "";

function readEnv() {
  const values = {};
  if (!fs.existsSync(ENV_FILE)) return values;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function writeEnv(input) {
  const current = readEnv();
  const next = {
    ...current,
    FEISHU_APP_ID: input.appId || current.FEISHU_APP_ID || "",
    FEISHU_APP_SECRET: input.appSecret || current.FEISHU_APP_SECRET || "",
    FEISHU_CHAT_ID: input.chatId || current.FEISHU_CHAT_ID || "",
    FEISHU_TEST_CHAT_ID: input.chatId || current.FEISHU_TEST_CHAT_ID || "",
    FEISHU_EVENT_VERIFY_TOKEN: input.verifyToken || current.FEISHU_EVENT_VERIFY_TOKEN || "",
    FEISHU_EVENT_ENCRYPT_KEY: input.encryptKey || current.FEISHU_EVENT_ENCRYPT_KEY || "",
  };
  fs.mkdirSync(PLATFORM_DIR, { recursive: true });
  fs.writeFileSync(
    ENV_FILE,
    Object.entries(next).map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "")}`).join("\n") + "\n",
    "utf8"
  );
  if (input.chatId) updateConfigs(input.chatId);
  return next;
}

function replaceChatId(value, chatId) {
  if (typeof value === "string") {
    return /^oc_test_/.test(value) ? chatId : value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceChatId(item, chatId));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = replaceChatId(value[key], chatId);
  }
  return value;
}

function updateConfigs(chatId) {
  for (const file of [CHANNELS_FILE, ROUTES_FILE]) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const next = replaceChatId(data, chatId);
    if (Array.isArray(next.channels)) {
      for (const channel of next.channels) channel.enabled = true;
    }
    if (Array.isArray(next.conversations)) {
      for (const conversation of next.conversations) conversation.enabled = true;
    }
    fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  }
}

function syncGroups(chatIds = []) {
  const ids = [...new Set(chatIds.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 10);
  if (!ids.length) return status();
  if (fs.existsSync(CHANNELS_FILE)) {
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    for (const channel of channels.channels || []) {
      channel.enabled = true;
      channel.allowed_chat_ids = ids;
    }
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), "utf8");
  }
  if (fs.existsSync(ROUTES_FILE)) {
    const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8"));
    const conversations = routes.conversations || [];
    const template = conversations[0];
    if (template) {
      routes.conversations = ids.map((chatId, index) => ({
        ...template,
        conversation_id: `${template.source_id || "feishu"}_${index + 1}`,
        chat_id: chatId,
        enabled: true,
      }));
      fs.writeFileSync(ROUTES_FILE, JSON.stringify(routes, null, 2), "utf8");
    }
  }
  return status();
}

function status() {
  const env = readEnv();
  return {
    platformDir: PLATFORM_DIR,
    running: Boolean(child && !child.killed),
    pid: child ? child.pid : null,
    startedAt,
    lastError,
    appIdConfigured: Boolean(env.FEISHU_APP_ID),
    secretConfigured: Boolean(env.FEISHU_APP_SECRET),
    chatIdConfigured: Boolean(env.FEISHU_CHAT_ID || env.FEISHU_TEST_CHAT_ID),
    chatId: env.FEISHU_CHAT_ID || env.FEISHU_TEST_CHAT_ID || "",
    hasEnv: fs.existsSync(ENV_FILE),
    logTail: readLog(),
  };
}

function readLog() {
  try {
    return fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).slice(-80).join("\n");
  } catch {
    return "";
  }
}

function startService() {
  if (child && !child.killed) return status();
  if (!fs.existsSync(path.join(PLATFORM_DIR, "src", "cli", "start_feishu_long_connection.js"))) {
    throw new Error("未找到消息平台长连接入口");
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] starting\n`, "utf8");
  child = spawn(process.execPath, ["src/cli/start_feishu_long_connection.js"], {
    cwd: PLATFORM_DIR,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  startedAt = new Date().toISOString();
  lastError = "";
  child.stdout.on("data", (chunk) => fs.appendFileSync(LOG_FILE, chunk.toString(), "utf8"));
  child.stderr.on("data", (chunk) => {
    lastError = chunk.toString().slice(-1000);
    fs.appendFileSync(LOG_FILE, chunk.toString(), "utf8");
  });
  child.on("exit", (code) => {
    fs.appendFileSync(LOG_FILE, `\n[${new Date().toISOString()}] exited code=${code}\n`, "utf8");
    lastError = `服务退出：${code}`;
    child = null;
  });
  return status();
}

function stopService() {
  if (!child || child.killed) return status();
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill();
  }
  child = null;
  return status();
}

module.exports = {
  PLATFORM_DIR,
  ENV_FILE,
  readEnv,
  writeEnv,
  syncGroups,
  status,
  startService,
  stopService,
};
