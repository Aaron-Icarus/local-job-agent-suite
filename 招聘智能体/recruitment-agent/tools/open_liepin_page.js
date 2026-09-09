const { cdpBaseUrl, getJson, sleep } = require("../src/core/cdp_common");

const targetUrl = process.env.LIEPIN_LOGIN_CHECK_URL || "https://c.liepin.com/";

async function findLiepinTab(base) {
  const tabs = await getJson(`${base}/json/list`);
  return tabs.find((tab) => tab.type === "page" && tab.webSocketDebuggerUrl && /liepin\.com/.test(tab.url || ""));
}

async function closeBlankTabs(base, keepId = "") {
  const tabs = await getJson(`${base}/json/list`);
  for (const tab of tabs.filter((item) => item.type === "page" && (item.url || "") === "about:blank" && item.id !== keepId)) {
    await fetch(`${base}/json/close/${tab.id}`).catch(() => {});
    console.log(`closed about:blank tab ${tab.id}`);
  }
}

async function closeDuplicateLiepinTabs(base, keepId) {
  const tabs = await getJson(`${base}/json/list`);
  for (const tab of tabs.filter((item) => item.type === "page" && item.id !== keepId && /liepin\.com/.test(item.url || ""))) {
    await fetch(`${base}/json/close/${tab.id}`).catch(() => {});
    console.log(`closed duplicate liepin tab ${tab.id}`);
  }
}

async function main() {
  const base = cdpBaseUrl();
  let tab = await findLiepinTab(base);
  if (!tab) {
    await getJson(`${base}/json/new?${targetUrl}`, { method: "PUT" });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !tab) {
      await sleep(1000);
      tab = await findLiepinTab(base);
    }
  }
  if (!tab) throw new Error("Could not open or find a liepin.com tab");
  await fetch(`${base}/json/activate/${tab.id}`).catch(() => {});
  await closeBlankTabs(base, tab.id);
  await closeDuplicateLiepinTabs(base, tab.id);
  console.log(JSON.stringify({ tabId: tab.id, title: tab.title, url: tab.url }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
