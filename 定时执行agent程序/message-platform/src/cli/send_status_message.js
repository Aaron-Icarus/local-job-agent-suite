const { loadConfig } = require("../core/config_loader");
const { sendFeishuText, delivered } = require("../channels/feishu_sender");

async function main() {
  const config = loadConfig();
  const chatId = process.argv.find((arg) => arg.startsWith("--chat-id="))?.slice("--chat-id=".length) || process.env.FEISHU_CHAT_ID;
  const textArg = process.argv.find((arg) => arg.startsWith("--text="));
  const text = textArg
    ? textArg.slice("--text=".length)
    : "AI消息群聊转发agent：框架代码已完成并自测通过，请在飞书群里 @机器人 进行正式测试。";
  const result = await sendFeishuText(text, { chatId });
  console.log(JSON.stringify({ delivered: delivered(result), envLoadResults: config.envLoadResults, result }, null, 2));
  if (!delivered(result)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
