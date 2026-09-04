const { loadConfig, findChannel } = require("../core/config_loader");
const { startFeishuLongConnection } = require("../channels/feishu_long_connection");

function bypassProxyForFeishuWebSocket() {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete process.env[key];
  }
}

function main() {
  bypassProxyForFeishuWebSocket();
  const config = loadConfig();
  const sourceId = process.argv.find((item) => item.startsWith("--source-id="))?.slice("--source-id=".length) || "feishu_moi_test_group";
  const channel = findChannel(config, sourceId);
  if (!channel) throw new Error(`Unknown source: ${sourceId}`);
  if (!channel.enabled) throw new Error(`Source is disabled: ${sourceId}`);
  if (channel.adapter?.mode !== "long_connection") throw new Error(`Source does not use long connection: ${sourceId}`);
  startFeishuLongConnection(config, channel);
  console.log(JSON.stringify({ ok: true, source_id: sourceId, event_type: channel.adapter.event_type, message: "long connection started" }));
  setInterval(() => {}, 60 * 60 * 1000);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { bypassProxyForFeishuWebSocket };
