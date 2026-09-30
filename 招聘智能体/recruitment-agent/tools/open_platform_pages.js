// 登录/手动浏览辅助：打开项目专用 CDP Chrome 中的 BOSS、猎聘 平台页面标签。
// 仅负责“找标签 / 开标签 / 导航到平台页 / 激活标签”，不执行登录校验、采集、筛选、评分、发送等任何后续动作。
const { cdpBaseUrl, getJson, sleep, openWsForTab, navigate } = require("../src/core/cdp_common");

// 平台目标页：url 为要打开的地址，domain 匹配同域名标签，exact 匹配“已在该页面”的标签。
const targets = [
  {
    name: "BOSS",
    url: "https://www.zhipin.com/web/geek/jobs",
    domain: /zhipin\.com/,
    exact: /zhipin\.com\/web\/geek\/jobs/,
  },
  {
    name: "猎聘",
    url: "https://c.liepin.com/",
    domain: /liepin\.com/,
    exact: /c\.liepin\.com/,
  },
];

function pageTabs(tabs) {
  return tabs.filter((t) => t && t.type === "page" && t.webSocketDebuggerUrl);
}

async function openTarget(base, target) {
  const exactMatch = (t) => target.exact.test(t.url || "");
  const domainMatch = (t) => target.domain.test(t.url || "");
  let tabs = await getJson(`${base}/json/list`);
  let tab = pageTabs(tabs).find(exactMatch) || pageTabs(tabs).find(domainMatch);
  if (!tab) {
    await getJson(`${base}/json/new?${target.url}`, { method: "PUT" });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !tab) {
      await sleep(1000);
      tabs = await getJson(`${base}/json/list`);
      tab = pageTabs(tabs).find(exactMatch) || pageTabs(tabs).find(domainMatch);
    }
  }
  if (!tab) return { name: target.name, ok: false, reason: "未能打开或定位标签页" };
  // 若标签停在同域名下的其它页面（例如采集遗留的职位详情页），导航回平台目标页
  if (!exactMatch(tab)) {
    const ws = await openWsForTab(tab);
    try {
      await navigate(ws, target.url, 6000);
    } finally {
      ws.close();
    }
    tabs = await getJson(`${base}/json/list`);
    tab = tabs.find((t) => t.id === tab.id) || tab;
  }
  await fetch(`${base}/json/activate/${tab.id}`).catch(() => {});
  return { name: target.name, ok: true, tabId: tab.id, url: tab.url };
}

async function main() {
  const base = cdpBaseUrl();
  const opened = [];
  for (const target of targets) {
    opened.push(await openTarget(base, target));
  }
  // 关闭多余的空白标签，保持浏览器整洁
  const tabs = await getJson(`${base}/json/list`);
  const keepIds = new Set(opened.map((r) => r.tabId).filter(Boolean));
  for (const blank of tabs.filter((t) => t.type === "page" && (t.url || "") === "about:blank" && !keepIds.has(t.id))) {
    await fetch(`${base}/json/close/${blank.id}`).catch(() => {});
  }
  console.log(JSON.stringify(opened, null, 2));
  process.exitCode = opened.some((r) => !r.ok) ? 2 : 0;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
