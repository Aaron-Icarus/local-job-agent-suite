const fs = require("fs");
const path = require("path");

function extractDisplayId(text) {
  const match = String(text || "").toUpperCase().match(/\b([AB]\d{3})\b/);
  return match ? match[1] : "";
}

function resolveJobRecord(text, indexPath) {
  const displayId = extractDisplayId(text);
  if (!displayId || !indexPath) return null;
  const resolved = path.resolve(indexPath);
  if (!fs.existsSync(resolved)) return null;
  const index = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const key = index.aliasesByDisplayId?.[displayId];
  const record = key ? index.jobsByKey?.[key] : null;
  return record ? { display_id: displayId, ...record } : null;
}

module.exports = { extractDisplayId, resolveJobRecord };
