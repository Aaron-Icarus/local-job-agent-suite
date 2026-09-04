const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { loadEnv, envBool } = require("../core/load_env");
const { sendRecruitmentNotification } = require("./outbound_sender");
const { shanghaiDateKey } = require("../core/time_utils");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const draftDir = path.join(rootDir, "data", "drafts");
const sentDir = path.join(rootDir, "data", "sent");
const statePath = path.join(rootDir, "data", "push_state.json");
const args = new Set(process.argv.slice(2));
const forceSend = args.has("--force-send");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function latestDraft() {
  const argPath = process.argv.find((arg) => arg.endsWith(".txt") || arg.endsWith(".md"));
  if (argPath) return path.resolve(argPath);
  const files = fs
    .readdirSync(draftDir)
    .filter((name) => /job_push_draft_.*\.(txt|md)$/.test(name))
    .map((name) => ({ full: path.join(draftDir, name), mtime: fs.statSync(path.join(draftDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files[0]) throw new Error(`No draft found in ${draftDir}`);
  return files[0].full;
}

function loadState() {
  if (!fs.existsSync(statePath)) return { seen: {}, sentDraftHashes: {}, reports: [] };
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function feishuWebhookSign(secret, timestamp) {
  return crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

async function sendFeishuWebhook(text) {
  const url = process.env.FEISHU_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: "FEISHU_WEBHOOK_URL not set" };
  const payload = { msg_type: "text", content: { text: text.slice(0, 18000) } };
  if (process.env.FEISHU_WEBHOOK_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = feishuWebhookSign(process.env.FEISHU_WEBHOOK_SECRET, timestamp);
  }
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { status: resp.status, body: await resp.text() };
}

async function sendFeishuApp(text) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const chatId = process.env.FEISHU_CHAT_ID || process.env.FEISHU_TEST_CHAT_ID;
  if (!appId || !appSecret || !chatId) return { skipped: true, reason: "FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_ID not set" };
  const tokenResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const tokenPayload = await tokenResp.json();
  if (!tokenResp.ok || !tokenPayload.tenant_access_token) {
    return { status: tokenResp.status, error: tokenPayload.msg || "failed to get tenant_access_token" };
  }
  const msgResp = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenPayload.tenant_access_token}`
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: text.slice(0, 18000) })
    })
  });
  return { status: msgResp.status, body: await msgResp.text() };
}

async function sendFeishu(text) {
  return sendRecruitmentNotification(text, { topic: "recruitment_report" });
}

function sendEmailWithPowerShell(draftPath) {
  if (!envBool("EMAIL_SEND_ENABLED", false)) return { skipped: true, reason: "EMAIL_SEND_ENABLED is false" };
  const subject = `${shanghaiDateKey()} ${process.env.REPORT_TITLE || "岗位搜索汇总"}`;
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(rootDir, "src", "push", "send_latest_draft_email.ps1"),
    "-ReportPath", draftPath,
    "-Subject", subject
  ], { cwd: rootDir, encoding: "utf8", env: process.env });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function delivered(result) {
  if (!result || result.skipped) return false;
  if (result.body) {
    try {
      const payload = JSON.parse(result.body);
      if (typeof payload.code === "number") return payload.code === 0;
    } catch {
      // Non-JSON 2xx responses are handled by HTTP status below.
    }
  }
  if (typeof result.status === "number") return result.status >= 200 && result.status < 300 || result.status === 0;
  return false;
}

async function main() {
  ensureDir(sentDir);
  const draftPath = latestDraft();
  const text = fs.readFileSync(draftPath, "utf8");
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const state = loadState();
  if (state.sentDraftHashes[hash] && !forceSend) {
    console.log(JSON.stringify({ draftPath, skipped: true, reason: "same draft already sent" }, null, 2));
    return;
  }
  const feishu = await sendFeishu(text);
  const email = sendEmailWithPowerShell(draftPath);
  const wasDelivered = delivered(feishu) || delivered(email);
  if (wasDelivered) {
    state.sentDraftHashes[hash] = new Date().toISOString();
    fs.copyFileSync(draftPath, path.join(sentDir, path.basename(draftPath)));
  }
  state.reports.push({
    at: new Date().toISOString(),
    draftPath,
    draftHash: hash,
    sendMode: "send-existing-draft",
    delivered: wasDelivered,
    feishu,
    email
  });
  saveState(state);
  if (!wasDelivered) process.exitCode = 1;
  console.log(JSON.stringify({ draftPath, delivered: wasDelivered, feishu, email }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
