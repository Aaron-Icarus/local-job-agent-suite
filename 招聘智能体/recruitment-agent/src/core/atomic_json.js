const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// 原子写：同目录临时文件 -> rename。中途崩溃不会留下半截 JSON。
function writeJsonAtomic(filePath, value, options = {}) {
  ensureDir(path.dirname(filePath));
  if (options.backup && fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, `${filePath}.bak`); } catch { /* backup is best-effort */ }
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(fd, text, "utf8");
    try { fs.fsyncSync(fd); } catch { /* fsync may not be available on every FS */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

module.exports = { ensureDir, readJson, writeJsonAtomic, appendJsonLine };
