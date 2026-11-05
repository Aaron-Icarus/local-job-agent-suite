const path = require("path");
const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const { openDatabase } = require("../src/v14/db");
const { startServer } = require("../src/v14/app_server");

let mainWindow = null;
let tray = null;
let server = null;
let db = null;

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
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg=="
  );
  tray = new Tray(icon);
  tray.setToolTip("招聘智能体 v1.4");
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

async function bootstrap() {
  const dbInfo = openDatabase(process.env.V14_DB_PATH || "");
  db = dbInfo.db;
  server = await startServer(db, { port: Number(process.env.V14_PORT || 0) });
  createWindow(server.url);
  createTray();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error);
    app.quit();
  });
  app.on("window-all-closed", () => {
    // 保持托盘常驻，不退出。
  });
  app.on("before-quit", async () => {
    app.isQuitting = true;
    if (server) await server.close();
    if (db) db.close();
  });
}
