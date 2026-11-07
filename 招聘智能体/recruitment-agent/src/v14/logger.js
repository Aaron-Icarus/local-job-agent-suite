const fs = require("fs");
const path = require("path");

const LOG_DIR = path.resolve(process.env.V14_LOG_DIR || path.join(__dirname, "..", "..", "data", "logs"));
const MAX_TOTAL_BYTES = Math.max(256 * 1024, Number(process.env.V14_LOG_MAX_BYTES || 5 * 1024 * 1024));
const MAX_FILES = 3;
const CURRENT = path.join(LOG_DIR, "app.log");

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function rotateIfNeeded(nextBytes = 0) {
  ensureDir();
  const currentSize = fileSize(CURRENT);
  const limitPerFile = Math.floor(MAX_TOTAL_BYTES / MAX_FILES);
  if (currentSize + nextBytes <= limitPerFile) return;
  try {
    const oldest = `${CURRENT}.${MAX_FILES - 1}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let index = MAX_FILES - 2; index >= 1; index -= 1) {
      const from = `${CURRENT}.${index}`;
      const to = `${CURRENT}.${index + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(CURRENT)) fs.renameSync(CURRENT, `${CURRENT}.1`);
  } catch {
    // 日志失败不能阻塞业务
  }
}

function write(level, action, message, data = {}) {
  try {
    const line = `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      action: String(action || "app"),
      message: String(message || ""),
      data,
    })}\n`;
    rotateIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(CURRENT, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

function info(action, message, data) { return write("info", action, message, data); }
function warn(action, message, data) { return write("warn", action, message, data); }
function error(action, message, data) { return write("error", action, message, data); }

function tail(limit = 200) {
  try {
    const files = [CURRENT, `${CURRENT}.1`, `${CURRENT}.2`].filter((file) => fs.existsSync(file));
    const lines = files.flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean));
    return lines.slice(-Math.max(1, Math.min(1000, Number(limit || 200))));
  } catch {
    return [];
  }
}

function stats() {
  const files = [CURRENT, `${CURRENT}.1`, `${CURRENT}.2`].map((file) => ({ file, bytes: fileSize(file), exists: fs.existsSync(file) }));
  return { dir: LOG_DIR, maxTotalBytes: MAX_TOTAL_BYTES, maxFiles: MAX_FILES, files, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0) };
}

module.exports = { LOG_DIR, MAX_TOTAL_BYTES, MAX_FILES, info, warn, error, tail, stats };
