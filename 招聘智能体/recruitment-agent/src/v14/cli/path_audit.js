const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..", "..", "..", "..");
const files = [];
const extensions = new Set([".js", ".json", ".ps1", ".cmd", ".command", ".sh", ".html", ".css", ".yaml", ".yml"]);
const skipDirs = new Set(["node_modules", ".git", "data", "logs", "outputs", "dist", "release", "build"]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitattributes") continue;
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(path.join(dir, entry.name));
  }
}

walk(root);
const patterns = [
  { name: "Windows 盘符路径", regex: /\b[A-Za-z]:\\[^\s"'`]+/g },
  { name: "Windows 正斜杠盘符路径", regex: /\b[A-Za-z]:\/[^\s"'`]+/g },
  { name: "macOS 用户绝对路径", regex: /\/Users\/[^\s"'`]+/g },
  { name: "Linux 用户绝对路径", regex: /\/home\/[^\s"'`]+/g },
];
const allow = new Set([
  "招聘智能体/recruitment-agent/src/v14/chrome_manager.js",
]);
const findings = [];
for (const file of files) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  if (allow.has(relative)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      findings.push({ file: relative, type: pattern.name, value: match[0] });
    }
  }
}
console.log(JSON.stringify({ ok: findings.length === 0, scanned: files.length, allowed: [...allow], findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
