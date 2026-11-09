const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

const logBase = process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support")
  : (process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), "AppData", "Local"));
const logDir = path.join(logBase, "JobAgent");
const logFile = path.join(logDir, "startup.log");
try {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] main.js loaded\n`);
} catch {
  // 日志失败不影响启动
}

function startupLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    try {
      fs.appendFileSync(path.join(path.dirname(process.execPath), "startup.log"), line);
    } catch {
      // 日志失败不影响启动
    }
  }
}

process.on("uncaughtException", (error) => {
  startupLog(`uncaughtException: ${error.stack || error.message}`);
});
process.on("unhandledRejection", (error) => {
  startupLog(`unhandledRejection: ${error && (error.stack || error.message) || error}`);
});
process.on("exit", (code) => {
  startupLog(`process exit: ${code}`);
});

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require("electron");

// Windows 上 %APPDATA%\boss-job-agent 可能被安全软件/遗留 ACL 拒绝写入，
// 导致单实例锁、缓存和日志失败。把 Electron 用户目录放到可写的 LocalAppData。
try {
  const userDataDir = path.join(logBase, "JobAgent", "ElectronProfile");
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath("userData", userDataDir);
  startupLog(`userData: ${userDataDir}`);
} catch (error) {
  startupLog(`set userData failed: ${error.message}`);
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverUrl = "";

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: "招聘智能体",
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(url);
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "icon.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg=="
    );
  tray = new Tray(icon);
  tray.setToolTip("招聘智能体 v1.5.3");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("double-click", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(`${url}/api/health`, (response) => {
          response.resume();
          if (response.statusCode === 200) return resolve(true);
          retry();
        })
        .on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error("后台服务启动超时"));
      setTimeout(attempt, 350);
    };
    attempt();
  });
}

function copyDirectory(source, target, options = {}) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (options.exclude?.includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to, options);
    else fs.copyFileSync(from, to);
  }
}

function preparePackagedData() {
  if (!app.isPackaged) return null;
  const userData = app.getPath("userData");
  const installRoot = path.dirname(process.execPath);
  // Windows 安装目录是用户选定且可写的；macOS 的 .app 包内不可写，使用用户数据目录。
  const dataRoot = process.platform === "win32"
    ? path.join(installRoot, "data")
    : path.join(userData, "data");
  fs.mkdirSync(path.join(dataRoot, "v1.4"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "exports"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "tmp"), { recursive: true });
  const messageTarget = process.platform === "win32"
    ? path.join(installRoot, "message-platform")
    : path.join(userData, "message-platform");
  const messageSource = path.join(process.resourcesPath, "runtime", "message-platform");
  try {
    if (fs.existsSync(messageSource) && !fs.existsSync(messageTarget)) {
      // 启动时复制轻量配置/源码；node_modules 也一并复制，保证群机器人 SDK 可用。
      copyDirectory(messageSource, messageTarget, { exclude: ["data", "logs", ".env"] });
    }
  } catch (error) {
    startupLog(`prepare message platform failed: ${error.message}`);
  }
  startupLog(`packaged data: ${dataRoot}`);
  return { userData, dataRoot, messageTarget };
}

function startBackend(port) {
  const packaged = app.isPackaged;
  const runtimeRoot = packaged ? path.join(process.resourcesPath, "runtime") : path.join(__dirname, "..");
  const nodeExe = process.env.V14_NODE
    || (packaged ? path.join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node") : "node");
  const script = path.join(runtimeRoot, "src", "v14", "cli", "serve.js");
  const packagedData = preparePackagedData();
  const env = {
    ...process.env,
    V14_PORT: String(port),
    LOCAL_CHAT_BASE_URL: serverUrl,
  };
  if (packaged && packagedData) {
    env.V14_DB_PATH = path.join(packagedData.dataRoot, "v1.4", "jobs.db");
    env.V14_LOG_DIR = path.join(packagedData.dataRoot, "logs");
    env.V14_SECRET_KEY_PATH = path.join(packagedData.dataRoot, "v1.4", "secret.key");
    env.V14_CHROME_PROFILE = path.join(packagedData.dataRoot, "ChromeProfile");
    env.V14_EXPORT_DIR = path.join(packagedData.dataRoot, "exports");
    env.V14_MESSAGE_PLATFORM_DIR = packagedData.messageTarget;
    env.V14_TEMP_DIR = path.join(packagedData.dataRoot, "tmp");
    env.TEMP = env.V14_TEMP_DIR;
    env.TMP = env.V14_TEMP_DIR;
  }
  const child = spawn(nodeExe, [script, `--port=${port}`], {
    cwd: runtimeRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => startupLog(`server stdout: ${chunk.toString().trim()}`));
  child.stderr.on("data", (chunk) => startupLog(`server stderr: ${chunk.toString().trim()}`));
  child.on("error", (error) => startupLog(`server spawn error: ${error.message}`));
  child.on("exit", (code, signal) => startupLog(`server exited: code=${code} signal=${signal}`));
  return child;
}

async function bootstrap() {
  startupLog("bootstrap start");
  const port = Number(process.env.V14_PORT || 0) || (await freePort());
  serverUrl = `http://127.0.0.1:${port}`;
  serverProcess = startBackend(port);
  startupLog(`backend starting: ${serverUrl}`);
  await waitForServer(serverUrl);
  startupLog(`backend ready: ${serverUrl}`);
  createWindow(serverUrl);
  startupLog("window created");
  createTray();
  startupLog("tray created");
}

function stopBackend() {
  if (!serverProcess || serverProcess.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], { windowsHide: true });
    } else {
      serverProcess.kill();
    }
  } catch (error) {
    startupLog(`stop backend error: ${error.message}`);
  }
}

const gotLock = app.requestSingleInstanceLock();
startupLog(`single instance lock: ${gotLock}`);
if (!gotLock) {
  // 某些 Windows 沙箱环境无法创建 Electron 的 SingletonLock（Error 5）。
  // 这里继续启动，避免应用静默退出；重复实例由用户自行关闭。
  startupLog("no single instance lock, continuing without it");
}
app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
app.whenReady().then(bootstrap).catch((error) => {
  startupLog(`bootstrap failed: ${error.stack || error.message}`);
  try {
    dialog.showErrorBox("招聘智能体启动失败", `${error.message}\n\n日志：${logFile}`);
  } catch {
    // ignore dialog failure
  }
  app.quit();
});
app.on("window-all-closed", () => {
  // 保持托盘常驻，不退出。
});
app.on("before-quit", () => {
  app.isQuitting = true;
  stopBackend();
});
