const path = require("path");
const { appendJsonLine } = require("../core/json_file");
const { processFeishuBody } = require("../app/process_event");

function resolveSdkPath() {
  const messageRoot = path.resolve(__dirname, "../..");
  const packageRoot = path.resolve(messageRoot, "../..");
  const candidates = [];
  const envNodeModules = process.env.MESSAGE_PLATFORM_VENDOR_NODE_MODULES;
  const envVendorRoot = process.env.MESSAGE_PLATFORM_VENDOR_ROOT;
  if (envNodeModules) {
    candidates.push(path.join(envNodeModules, "@larksuiteoapi", "node-sdk"));
  }
  if (envVendorRoot) {
    candidates.push(path.join(envVendorRoot, "node_modules", "@larksuiteoapi", "node-sdk"));
  }
  candidates.push(path.join(packageRoot, "快捷启动", "随项目必须的安装包", "message-platform-vendor", "node_modules", "@larksuiteoapi", "node-sdk"));
  candidates.push(path.join(messageRoot, "vendor", "node_modules", "@larksuiteoapi", "node-sdk"));

  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch (_) {
      // Try the next known runtime location.
    }
  }
  const safeRoot = packageRoot.replace(/'/g, "''");
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '${safeRoot}'; & '.\\快捷启动\\快捷启动脚本\\prepare_runtime_menu.ps1'"`;
  throw new Error(`未找到飞书长连接 SDK。请先运行完整命令：${command}；或设置 MESSAGE_PLATFORM_VENDOR_ROOT。`);
}

function sdk() {
  return require(resolveSdkPath());
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

module.exports = { startFeishuLongConnection, toFeishuBody, resolveSdkPath };
