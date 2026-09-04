const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return false;
  const text = fs.readFileSync(resolved, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function loadEnvFiles(rootDir, envFiles = []) {
  return envFiles.map((item) => ({
    path: path.resolve(rootDir, item),
    loaded: loadEnvFile(path.resolve(rootDir, item))
  }));
}

module.exports = { loadEnvFile, loadEnvFiles };
