const { cdpBaseUrl, getJson } = require("../src/core/cdp_common");

async function main() {
  const base = cdpBaseUrl();
  const tabs = await getJson(`${base}/json/list`);
  const blanks = tabs.filter((tab) => tab.type === "page" && (tab.url || "") === "about:blank");
  for (const tab of blanks) {
    try {
      await fetch(`${base}/json/close/${tab.id}`);
      console.log(`closed about:blank tab ${tab.id}`);
    } catch (error) {
      console.error(`failed to close ${tab.id}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
