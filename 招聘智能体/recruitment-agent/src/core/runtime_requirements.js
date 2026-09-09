const MINIMUM_NODE = [22, 4, 0];

function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = Number(left[index] || 0) - Number(right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function runtimeIssues() {
  const issues = [];
  const parsed = parseVersion(process.versions.node);
  if (!parsed || compareVersion(parsed, MINIMUM_NODE) < 0) {
    issues.push(`Node.js 版本过低：当前 ${process.versions.node}，最低需要 22.4.0。`);
  }
  if (typeof globalThis.fetch !== "function") issues.push("当前 Node.js 没有全局 fetch，无法调用平台和发送接口。");
  if (typeof globalThis.WebSocket !== "function") issues.push("当前 Node.js 没有稳定可用的全局 WebSocket，无法连接 Chrome CDP。");
  return issues;
}

module.exports = { MINIMUM_NODE, parseVersion, compareVersion, runtimeIssues };
