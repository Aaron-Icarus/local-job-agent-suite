#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { findChrome } = require("../chrome_manager");

function exists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function main() {
  const root = path.resolve(__dirname, "..", "..", "..");
  const chrome = findChrome();
  const electronPath = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "Electron.app");
  const messagePlatform = path.resolve(root, "..", "..", "消息平台", "message-platform");
  const checks = [
    { name: "操作系统", value: process.platform, ok: ["win32", "darwin"].includes(process.platform) },
    { name: "Node.js", value: process.version, ok: Number(process.versions.node.split(".")[0]) >= 22 },
    { name: "Chrome", value: chrome || "未找到", ok: Boolean(chrome) },
    { name: "Electron", value: exists(electronPath) ? "已安装" : "未安装", ok: exists(electronPath) },
    { name: "消息平台目录", value: messagePlatform, ok: exists(messagePlatform) },
    {
      name: "消息平台依赖",
      value: exists(path.join(messagePlatform, "node_modules", "@larksuiteoapi", "node-sdk"))
        ? "已安装"
        : "未安装（群机器人入站需要）",
      ok: exists(path.join(messagePlatform, "node_modules", "@larksuiteoapi", "node-sdk")),
    },
  ];
  console.log(JSON.stringify({ ok: checks.every((item) => item.ok), platform: process.platform, checks }, null, 2));
  process.exitCode = checks.filter((item) => ["Node.js", "Chrome", "Electron"].includes(item.name) && !item.ok).length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { main };
