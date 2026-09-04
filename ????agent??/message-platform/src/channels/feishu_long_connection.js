const path = require("path");
const { appendJsonLine } = require("../core/json_file");
const { processFeishuBody } = require("../app/process_event");

function sdk() {
  return require(path.resolve(__dirname, "../../vendor/node_modules/@larksuiteoapi/node-sdk"));
}

function toFeishuBody(event) {
  if (event.header && event.event) return event;
  return {
    header: {
      event_id: event.event_id || "",
      event_type: "im.message.receive_v1"
    },
    event
  };
}

function startFeishuLongConnection(config, channel) {
  const Lark = sdk();
  const credentialEnv = channel.credential_env || {};
  const appId = process.env[credentialEnv.app_id || "FEISHU_APP_ID"];
  const appSecret = process.env[credentialEnv.app_secret || "FEISHU_APP_SECRET"];
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID/FEISHU_APP_SECRET not set");
  const eventLog = path.resolve(config.rootDir, config.runtime.state.event_log_path);
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      const body = toFeishuBody(event);
      try {
        const result = await processFeishuBody(body, { rootDir: config.rootDir, sourceId: channel.source_id });
        appendJsonLine(eventLog, {
          at: new Date().toISOString(),
          transport: "feishu_long_connection",
          event_id: body.header.event_id,
          message_id: body.event?.message?.message_id || "",
          accepted: result.accepted,
          reason: result.reason || "",
          delivered: Boolean(result.delivered)
        });
        return result;
      } catch (error) {
        appendJsonLine(eventLog, {
          at: new Date().toISOString(),
          transport: "feishu_long_connection",
          event_id: body.header.event_id,
          error: error.message
        });
        throw error;
      }
    }
  });
  const client = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.info });
  client.start({ eventDispatcher: dispatcher });
  return client;
}

module.exports = { startFeishuLongConnection, toFeishuBody };
