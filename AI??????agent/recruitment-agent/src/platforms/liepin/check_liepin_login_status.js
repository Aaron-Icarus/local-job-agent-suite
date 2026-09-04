const { loadEnv } = require("../../core/load_env");
const { cdpBaseUrl, findOrCreateTab, getJson, openWsForTab, navigate, sleep, evaluate } = require("../../core/cdp_common");

loadEnv();

const targetUrl = process.env.LIEPIN_LOGIN_CHECK_URL || "https://c.liepin.com/";
const args = new Set(process.argv.slice(2));

function classify(value) {
  const text = `${value.href || ""}\n${value.sample || ""}`;
  if (/安全验证|滑块|环境异常|访问异常|verify|captcha/i.test(text)) return "security_check";
  if (/登录\/注册|扫码登录|密码登录|验证码登录|请登录|登录后/.test(text) && !/我的投递|我的收藏|简历完整度|谁看过我|编辑简历/.test(text)) {
    return "login_required";
  }
  if (/我的投递|我的收藏|简历完整度|谁看过我|编辑简历|猎头顾问|招聘专员/.test(text)) return "logged_in";
  return "unknown";
}

async function main() {
  const base = cdpBaseUrl();
  let tab = await findOrCreateTab((url) => /liepin\.com/.test(url), targetUrl);
  if ((tab.url || "") === "about:blank" || (args.has("--new") && !/liepin\.com/.test(tab.url || ""))) {
    await getJson(`${base}/json/new?${targetUrl}`, { method: "PUT" });
  }

  const deadline = Date.now() + 25000;
  let value = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    const tabs = await getJson(`${base}/json/list`);
    const liepinTabs = tabs
      .filter((item) => item.type === "page" && item.webSocketDebuggerUrl && /liepin\.com/.test(item.url || ""))
      .sort((a, b) => (a.id === tab.id ? -1 : 0) - (b.id === tab.id ? -1 : 0));
    if (!liepinTabs.length) continue;
    tab = liepinTabs[0];
    await fetch(`${base}/json/activate/${tab.id}`).catch(() => {});
    for (const blank of tabs.filter((item) => item.type === "page" && (item.url || "") === "about:blank" && item.id !== tab.id)) {
      await fetch(`${base}/json/close/${blank.id}`).catch(() => {});
    }
    const ws = await openWsForTab(tab);
    try {
      value = await evaluate(ws, `(() => {
      const text = document.body ? document.body.innerText : "";
      return {
        title: document.title,
        href: location.href,
        textLength: text.length,
        hasUserArea: /我的投递|我的收藏|简历完整度|谁看过我|编辑简历/.test(text),
        hasLoginText: /登录\\/注册|扫码登录|密码登录|验证码登录|请登录/.test(text),
        hasSecurityText: /安全验证|滑块|环境异常|访问异常|verify|captcha/i.test(text + location.href),
        sample: text.slice(0, 500)
      };
    })()`);
    } finally {
      ws.close();
    }
    if (value && value.href && value.href !== "about:blank") break;
  }
  if (!value) {
    value = { title: tab.title || "", href: tab.url || "", textLength: 0, hasUserArea: false, hasLoginText: false, hasSecurityText: false, sample: "" };
  }
  const loginStatus = classify(value);
  console.log(JSON.stringify({ loginStatus, tabId: tab.id, ...value }, null, 2));
  if (loginStatus !== "logged_in") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
