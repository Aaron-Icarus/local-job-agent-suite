const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, validateConfig } = require("../src/core/config_loader");
const { parseFeishuEvent } = require("../src/channels/feishu_event_parser");
const { cleanExternalMessage } = require("../src/messages/message_cleaner");
const { processFeishuBody } = require("../src/app/process_event");
const { buildJobGreetingPrompt } = require("../src/prompts/job_greeting_prompt");
const { decide } = require("../../../AI消息群聊转发agent/recruitment-agent/src/main/scheduled_entry");

function cloneConfigWithTempState(config) {
  const copy = JSON.parse(JSON.stringify(config));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-agent-test-"));
  copy.runtime.state.session_store_path = path.join(tempDir, "sessions.json");
  copy.runtime.state.event_log_path = path.join(tempDir, "events.log");
  copy.runtime.state.event_store_path = path.join(tempDir, "inbound_events.json");
  copy.channels.forEach((channel) => { channel.enabled = true; });
  copy.conversations.forEach((conversation) => { conversation.enabled = true; });
  return copy;
}

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const config = loadConfig(rootDir);
  const oldChannel = config.channels.find((item) => item.source_id === "feishu_jobs_group");
  const oldConversation = config.conversations.find((item) => item.source_id === "feishu_jobs_group");
  assert.deepStrictEqual(validateConfig(config), []);
  assert.strictEqual(config.channels[0].enabled, false, "shared package must start with its channels disabled");
  assert.strictEqual(config.conversations[0].enabled, false, "shared package must start with its routes disabled");

  const pingBody = JSON.parse(fs.readFileSync(path.join(rootDir, "tests", "fixtures", "feishu_ping_event.json"), "utf8"));
  const parsed = parseFeishuEvent(pingBody);
  assert.strictEqual(parsed.chat_id, "oc_test_jobs_group");
  const cleaned = cleanExternalMessage(parsed, oldChannel, oldConversation.message_cleaner);
  assert.strictEqual(cleaned.mentions_bot, true);
  assert.strictEqual(cleaned.clean_text, "ping");

  const placeholderCleaned = cleanExternalMessage({
    source: "feishu",
    chat_id: "oc_test_moi_group",
    sender_id: "ou_test_user",
    message_id: "om_placeholder_test",
    text: "@_user_1 处理 A004，写一个打招呼话术",
    mentions: [{ key: "@_user_1", mentioned_type: "app" }],
    attachments: []
  }, config.channels[0], config.conversations[0].message_cleaner);
  assert.strictEqual(placeholderCleaned.clean_text, "处理 A004，写一个打招呼话术");

  const disabledConfig = JSON.parse(JSON.stringify(config));
  disabledConfig.channels.find((item) => item.source_id === "feishu_jobs_group").enabled = false;
  disabledConfig.conversations.find((item) => item.source_id === "feishu_jobs_group").enabled = false;
  const disabledResult = await processFeishuBody(pingBody, { config: disabledConfig, send: false });
  assert.strictEqual(disabledResult.accepted, false);
  assert.strictEqual(disabledResult.reason, "channel_disabled");

  const enabledConfig = cloneConfigWithTempState(config);
  const pingResult = await processFeishuBody(pingBody, { config: enabledConfig, send: false });
  assert.strictEqual(pingResult.accepted, true);
  assert.strictEqual(pingResult.agent_id, "ping_agent");
  assert.match(pingResult.output.reply_text, /pong/);

  const greetingBody = JSON.parse(fs.readFileSync(path.join(rootDir, "tests", "fixtures", "feishu_greeting_event.json"), "utf8"));
  const greetingResult = await processFeishuBody(greetingBody, { config: enabledConfig, send: false });
  assert.strictEqual(greetingResult.accepted, true);
  assert.strictEqual(greetingResult.agent_id, "job_greeting_agent");
  const greetingLine = greetingResult.output.reply_text.split(/\r?\n/).slice(-1)[0];
  assert.match(greetingLine, /候选人画像尚未配置/);

  const liveBody = {
    header: { event_id: "evt_live_test", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_test_user" } },
      message: {
        message_id: "om_live_test",
        chat_id: "oc_test_moi_group",
        chat_type: "group",
        message_type: "text",
        content: "{\"text\":\"@_user_1 处理【BOSS】示例科技 - AI项目经理｜20-30K｜上海 岗位要求：AI Agent、项目交付、需求分析，写一个打招呼话术\"}",
        mentions: [{ key: "@_user_1", mentioned_type: "app" }]
      }
    }
  };
  const liveResult = await processFeishuBody(liveBody, { config: enabledConfig, sourceId: "feishu_moi_test_group", send: false });
  assert.strictEqual(liveResult.accepted, true);
  assert.match(liveResult.cleaned.clean_text, /示例科技/);
  assert.match(liveResult.output.reply_text, /示例科技/);
  assert.match(liveResult.output.reply_text, /AI项目经理/);

  const a004Prompt = buildJobGreetingPrompt(
    { clean_text: "我需要对职位 A004，写一个打招呼话术", session: { context_summary: "这是本轮新任务。" } },
    config.agents.find((item) => item.agent_id === "job_greeting_agent"),
    rootDir
  );
  assert.match(a004Prompt, /未找到岗位编号对应的档案/);
  assert.match(a004Prompt, /不含个人信息的示例画像/);

  const followupBody = JSON.parse(JSON.stringify(greetingBody));
  followupBody.header.event_id = "evt_test_followup";
  followupBody.event.message.message_id = "om_test_followup";
  followupBody.event.message.parent_id = "om_test_greeting";
  followupBody.event.message.content = "{\"text\":\"@岗位助手 结果不对，把项目管理优势再强调一点\"}";
  const followupResult = await processFeishuBody(followupBody, { config: enabledConfig, send: false });
  assert.strictEqual(followupResult.accepted, true);
  assert.strictEqual(followupResult.session.action, "continue");
  assert.strictEqual(followupResult.session.session.session_id, greetingResult.session.session.session_id);

  const duplicateResult = await processFeishuBody(followupBody, { config: enabledConfig, send: false });
  assert.strictEqual(duplicateResult.accepted, true);
  assert.strictEqual(duplicateResult.duplicate, true);

  const scheduleState = {
    collectRuns: [
      { at: "2026-09-03T00:30:00.000Z", dateKey: "2026-09-03", slot: "morning", status: "success" },
      { at: "2026-09-03T05:00:00.000Z", dateKey: "2026-09-03", slot: "afternoon", status: "success" }
    ],
    reportRuns: []
  };
  const preReport = decide(scheduleState, new Date("2026-09-03T17:30:00+08:00"));
  assert.strictEqual(preReport.action, "collect_only");
  assert.strictEqual(preReport.slot, "pre_report");
  const delivery = decide({ ...scheduleState, collectRuns: [...scheduleState.collectRuns, { at: "2026-09-03T09:00:00.000Z", dateKey: "2026-09-03", slot: "pre_report", status: "success" }] }, new Date("2026-09-03T19:30:00+08:00"));
  assert.strictEqual(delivery.action, "collect_and_report");
  const deferred = decide({ ...scheduleState, reportRuns: [{ dateKey: "2026-09-03", status: "failed" }] }, new Date("2026-09-03T20:00:00+08:00"));
  assert.strictEqual(deferred.action, "skip");

  console.log("All tests passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
