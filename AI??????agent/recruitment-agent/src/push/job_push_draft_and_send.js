const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { sendRecruitmentNotification } = require("./outbound_sender");
const { loadEnv, envBool, envNumber } = require("../core/load_env");
const { shanghaiDateKey } = require("../core/time_utils");
const { recommendGreeting, recommendGreetingResult } = require("../greeting/greeting_recommender");
const {
  loadJobStore,
  saveJobStore,
  upsertRecords,
  markPushedItems,
  jobStoreKey,
} = require("../store/job_store");
const {
  loadDisplayIndex,
  saveDisplayIndex,
  decorateRecordsWithDisplayIds,
  markRecommended,
} = require("./job_display_index");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(rootDir, "outputs");
const draftDir = process.env.DRAFT_DIR || path.join(rootDir, "data", "drafts");
const sentDir = process.env.SENT_DIR || path.join(rootDir, "data", "sent");
const statePath = process.env.PUSH_STATE_PATH || path.join(rootDir, "data", "push_state.json");
const displayIndexPath = process.env.JOB_DISPLAY_INDEX_PATH || path.join(rootDir, "data", "job_display_index.json");
const args = new Set(process.argv.slice(2));
const shouldSend = args.has("--send") || process.env.SEND_MODE === "send";
const forceSend = args.has("--force-send");
const enableJobStore = envBool("ENABLE_JOB_STORE", true);
const reportTopN = envNumber("REPORT_TOP_N", 12);
const splitByPlatform = envBool("REPORT_SPLIT_BY_PLATFORM", true);
const similarThreshold = envNumber("SIMILAR_JOB_THRESHOLD", 0.8);
const similarWindowDays = envNumber("SIMILAR_JOB_WINDOW_DAYS", 45);
const today = shanghaiDateKey();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function latestFile(pattern) {
  const files = fs
    .readdirSync(outputsDir)
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, full: path.join(outputsDir, name), mtime: fs.statSync(path.join(outputsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files[0]) throw new Error(`No evaluated job file found in ${outputsDir}`);
  return files[0].full;
}

function latestFiles(patterns) {
  return patterns.map((pattern) => {
    try {
      return latestFile(pattern);
    } catch {
      return "";
    }
  }).filter(Boolean);
}

function loadState() {
  if (!fs.existsSync(statePath)) return { seen: {}, deliveries: {}, sentDraftHashes: {}, reports: [] };
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const deliveries = parsed.deliveries || {};
  // Migrate prior successful reports once.  Legacy reports do not carry the
  // field-level signature, so they are treated as delivered-but-not-eligible
  // for automatic change resend until a new delivery establishes a signature.
  for (const report of parsed.reports || []) {
    for (const message of report.messages || []) {
      if (!message.delivered) continue;
      for (const item of message.items || []) {
        const key = `${message.channelName || item.channelName || item.platform || "全部"}:${item.push_key}`;
        if (!deliveries[key]) deliveries[key] = {
          delivered_at: report.at || "",
          signature: "",
          display_id: item.display_id || "",
          legacy: true,
        };
      }
    }
  }
  return {
    seen: parsed.seen || {},
    deliveries,
    sentDraftHashes: parsed.sentDraftHashes || {},
    reports: parsed.reports || [],
  };
}

function saveState(state) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function keywordGroups(row) {
  const groups = parseJsonField(row.used_search_keyword_groups_json, []);
  if (groups.length) {
    return groups.map((group) => Array.isArray(group) ? group.join(" + ") : String(group)).join("; ");
  }
  return row.keyword || "";
}

function jobKey(row) {
  const platform = row.platform || (row.liepin_job_url ? "猎聘" : "BOSS");
  return `${platform}:${row.record_key || row.semantic_duplicate_key || row.liepin_job_url || `${row.company || ""}|${row.job_title || ""}|${row.salary || ""}|${row.district || row.city || ""}`}`;
}

function deliveryKey(row, channelName = "") {
  return `${channelName || platformName(row)}:${jobKey(row)}`;
}

function deliverySignature(row) {
  return JSON.stringify({
    focus_level: row.focus_level || "",
    salary: row.salary || "",
    latest_active_date: row.latest_active_date || "",
    overall_fit_score: Number(row.overall_fit_score || 0),
    application_success_score: Number(row.application_success_score || 0),
  });
}

function isCandidate(row) {
  return ["重点关注", "重点关注-需确认详情", "可关注"].includes(row.focus_level);
}

function sortByPriority(a, b) {
  const ad = a.similar_duplicate === "是" ? 1 : 0;
  const bd = b.similar_duplicate === "是" ? 1 : 0;
  if (ad !== bd) return ad - bd;
  const af = Number(a.overall_fit_score || 0);
  const bf = Number(b.overall_fit_score || 0);
  if (bf !== af) return bf - af;
  return Number(b.application_success_score || 0) - Number(a.application_success_score || 0);
}

function jobLink(row) {
  if (row.liepin_job_id) return `https://www.liepin.com/a/${row.liepin_job_id}.shtml`;
  const liepinUrl = row.liepin_job_url || (row.source_url && String(row.source_url).includes("liepin.com") ? row.source_url : "");
  if (liepinUrl) {
    const id = String(liepinUrl).match(/\/a\/(\d+)\.shtml|job_id=(\d+)/);
    return id ? `https://www.liepin.com/a/${id[1] || id[2]}.shtml` : String(liepinUrl).split("?")[0];
  }
  if (row.job_id) {
    return `https://www.zhipin.com/job_detail/${row.job_id}.html`;
  }
  if (row.detail_url && !String(row.detail_url).includes("/wapi/")) return row.detail_url;
  return "";
}

function platformName(row) {
  return row.platform || (row.liepin_job_url ? "猎聘" : "BOSS");
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function activeBrief(row) {
  const raw = singleLine(row.boss_active_text || row.recruiter_active_text || row.latest_active_date || "");
  const match = raw.match(/当前在线|刚刚在线|刚刚活跃|\d+\s*分钟前在线|\d+\s*小时前在线|\d+\s*天前在线|\d+\s*分钟前活跃|\d+\s*小时前活跃|\d+\s*天前活跃|今日活跃|今天活跃|本周活跃/);
  return match ? match[0].replace(/\s+/g, "") : (row.latest_active_date || "活跃未知");
}

function locationBrief(row) {
  return row.district || row.business_area || row.address || row.city || "地点未知";
}

function safeName(value) {
  return String(value || "unknown").replace(/[\\/:*?"<>|\s]+/g, "_");
}

function oneLineMatch(row) {
  const reasons = parseJsonField(row.match_reasons_json, []);
  const preferred = reasons.filter((reason) => /AI|智能体|大模型|项目|交付|产品|需求|方案|薪资|地点|活跃/.test(reason));
  const picked = (preferred.length ? preferred : reasons).slice(0, 2);
  if (picked.length) return picked.join("，") + "。";
  if (row.evaluation_summary) {
    const first = String(row.evaluation_summary).split(/[；。]/).find(Boolean);
    if (first) return `${first}。`;
  }
  return "岗位方向与 AI 项目/产品/交付目标有交集，建议打开详情确认。";
}

function duplicateHint(row) {
  if (row.similar_duplicate !== "是") return "";
  const base = row.duplicate_of_display_id || "前序岗位";
  if (row.similar_duplicate_recommended_before === "是") {
    return `重复提示：近似岗位 ${base} 之前已推荐过。`;
  }
  return `重复提示：近似岗位 ${base}，排序已后置。`;
}

function compactText(row) {
  const displayId = row.display_id ? `${row.display_id} ` : "";
  const brief = `${displayId}【${platformName(row)}】${firstLine(row.company) || "未知公司"} - ${singleLine(row.job_title) || "未知岗位"}｜${row.salary || "薪资未知"}｜${locationBrief(row)}｜${activeBrief(row)}`;
  const lines = [
    brief,
    `匹配点：${oneLineMatch(row)}`,
    `打招呼：${row.greeting_message || recommendGreeting(row)}`,
  ];
  const hint = duplicateHint(row);
  if (hint) lines.push(hint);
  lines.push(`链接：${jobLink(row) || "暂无"}`);
  return lines.join("\n");
}

function buildPushItem(row, index, channelName) {
  const link = jobLink(row) || "";
  const matchPoint = oneLineMatch(row);
  const location = locationBrief(row);
  const activeText = activeBrief(row);
  const messageText = compactText(row);
  return {
    job_store_key: jobStoreKey(row),
    push_key: jobKey(row),
    report_index: index + 1,
    channelName: channelName || platformName(row),
    display_id: row.display_id || "",
    platform: platformName(row),
    company: firstLine(row.company) || "未知公司",
    job_title: singleLine(row.job_title) || "未知岗位",
    salary: row.salary || "薪资未知",
    location,
    active_text: activeText,
    match_point: matchPoint,
    link,
    message_text: messageText,
    push_summary: `${row.display_id ? `${row.display_id} ` : ""}${platformName(row)} ${firstLine(row.company) || "未知公司"} - ${singleLine(row.job_title) || "未知岗位"}｜${row.salary || "薪资未知"}｜${location}｜${activeText}`,
  };
}

function buildReport(records, state, inputPath, channelName = "") {
  const candidates = records.filter(isCandidate);
  const newCandidates = candidates.filter((row) => !state.deliveries[deliveryKey(row, channelName)]);
  const changedCandidates = candidates.filter((row) => {
    const previousDelivery = state.deliveries[deliveryKey(row, channelName)];
    return Boolean(previousDelivery?.signature && previousDelivery.signature !== deliverySignature(row));
  });
  const priority = [...newCandidates, ...changedCandidates].sort(sortByPriority).slice(0, reportTopN);
  // A quiet day is still reported, but already delivered jobs are not silently
  // recycled just because the dated report text has a new hash.
  const fallbackPriority = priority;
  const title = channelName
    ? `${today} ${channelName}岗位搜索汇总`
    : `${today} ${process.env.REPORT_TITLE || "岗位搜索汇总"}`;
  const platformCounts = records.reduce((acc, row) => {
    const key = platformName(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const duplicateCount = fallbackPriority.filter((row) => row.similar_duplicate === "是").length;
  const md = [
    `# ${title}`,
    "",
    `记录 ${records.length} 条，可关注 ${candidates.length} 条，展示 ${fallbackPriority.length} 条，近似重复 ${duplicateCount} 条。平台分布：${Object.entries(platformCounts).map(([k, v]) => `${k}${v}`).join("，") || "无"}。`,
    "",
    ...fallbackPriority.flatMap((row, index) => [
      `${index + 1}. ${row.display_id ? `${row.display_id} ` : ""}【${platformName(row)}】${firstLine(row.company) || "未知公司"} - ${singleLine(row.job_title) || "未知岗位"}｜${row.salary || "薪资未知"}｜${locationBrief(row)}｜${activeBrief(row)}`,
      `匹配点：${oneLineMatch(row)}`,
      `打招呼：${row.greeting_message || recommendGreeting(row)}`,
      ...(duplicateHint(row) ? [duplicateHint(row)] : []),
      `链接：${jobLink(row) || "暂无"}`,
      "",
    ])
  ].join("\r\n");
  const text = [
    title,
    `记录 ${records.length} 条，可关注 ${candidates.length} 条，展示 ${fallbackPriority.length} 条，近似重复 ${duplicateCount} 条。平台分布：${Object.entries(platformCounts).map(([k, v]) => `${k}${v}`).join("，") || "无"}。`,
    "",
    ...fallbackPriority.map((row, index) => `${index + 1}. ${compactText(row)}`)
  ].join("\n\n");
  return { md, text, candidates, newCandidates, changedCandidates, priority: fallbackPriority };
}

function groupReports(records, state, inputPath) {
  if (!splitByPlatform) {
    return [{ channelName: "", records, report: buildReport(records, state, inputPath) }];
  }
  const groups = new Map();
  for (const row of records) {
    const key = platformName(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
    .map(([channelName, rows]) => ({
      channelName,
      records: rows,
      report: buildReport(rows, state, inputPath, channelName),
    }));
}

function updateSeen(state, records) {
  for (const row of records) {
    const key = jobKey(row);
    state.seen[key] = {
      company: row.company,
      job_title: row.job_title,
      salary: row.salary,
      focus_level: row.focus_level,
      latest_active_date: row.latest_active_date,
      overall_fit_score: row.overall_fit_score,
      last_seen_at: new Date().toISOString()
    };
  }
}

function markDelivered(state, records, channelName) {
  for (const row of records) {
    state.deliveries[deliveryKey(row, channelName)] = {
      delivered_at: new Date().toISOString(),
      signature: deliverySignature(row),
      display_id: row.display_id || "",
    };
  }
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

function sendEmailWithPowerShell(txtPath, subject) {
  if (!envBool("EMAIL_SEND_ENABLED", false)) return { skipped: true, reason: "EMAIL_SEND_ENABLED is false" };
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(rootDir, "src", "push", "send_latest_draft_email.ps1"),
    "-ReportPath", txtPath,
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
  ensureDir(draftDir);
  ensureDir(sentDir);
  const inputPaths = process.argv.filter((arg) => arg.endsWith(".json"));
  const resolvedInputPaths = inputPaths.length
    ? inputPaths
    : latestFiles([/^boss_stage3_fit_evaluated_.*\.json$/, /^liepin_stage3_fit_evaluated_.*\.json$/]);
  const payloads = resolvedInputPaths.map((inputPath) => ({ inputPath, payload: JSON.parse(fs.readFileSync(inputPath, "utf8")) }));
  const records = payloads.flatMap(({ inputPath, payload }) => (payload.records || []).map((row) => ({
    platform: payload.platform || row.platform || (row.liepin_job_url ? "猎聘" : "BOSS"),
    source_evaluated_file: inputPath,
    ...row
  })));
  const state = loadState();
  const displayIndex = loadDisplayIndex(displayIndexPath);
  decorateRecordsWithDisplayIds(records, { index: displayIndex, threshold: similarThreshold, windowDays: similarWindowDays });
  const jobStore = enableJobStore ? loadJobStore() : null;
  if (jobStore) {
    upsertRecords(jobStore, records, { dateKey: today });
  }
  const reportGroups = groupReports(records, state, resolvedInputPaths.join("; "));
  const results = [];
  for (const group of reportGroups) {
    for (const row of group.report.priority) {
      const greeting = await recommendGreetingResult(row);
      row.greeting_message = greeting.message;
      row.greeting_strategy = greeting.strategy;
      row.greeting_basis = greeting.basis;
    }
    group.report = buildReport(group.records, state, resolvedInputPaths.join("; "), group.channelName);
    const suffix = group.channelName ? `_${safeName(group.channelName)}` : "";
    const mdPath = path.join(draftDir, `${today}${suffix}_job_push_draft_${stamp}.md`);
    const txtPath = path.join(draftDir, `${today}${suffix}_job_push_draft_${stamp}.txt`);
    fs.writeFileSync(mdPath, group.report.md, "utf8");
    fs.writeFileSync(txtPath, group.report.text, "utf8");
    const pushItems = group.report.priority.map((row, index) => buildPushItem(row, index, group.channelName));
    markRecommended(displayIndex, group.report.priority);
    const draftHash = crypto.createHash("sha256").update(group.report.text).digest("hex");
    let sendResult = { skipped: true, reason: "draft mode" };
    let emailResult = { skipped: true, reason: "draft mode" };
    let deliveredNow = false;
    if (shouldSend) {
      if (state.sentDraftHashes[draftHash] && !forceSend) {
        sendResult = { skipped: true, reason: "same draft already sent" };
        emailResult = { skipped: true, reason: "same draft already sent" };
      } else {
        sendResult = await sendFeishu(group.report.text);
        const subject = group.channelName ? `${today} ${group.channelName}岗位搜索汇总` : `${today} ${process.env.REPORT_TITLE || "岗位搜索汇总"}`;
        emailResult = sendEmailWithPowerShell(txtPath, subject);
        deliveredNow = delivered(sendResult) || delivered(emailResult);
        if (deliveredNow) {
          state.sentDraftHashes[draftHash] = new Date().toISOString();
          fs.copyFileSync(mdPath, path.join(sentDir, path.basename(mdPath)));
          fs.copyFileSync(txtPath, path.join(sentDir, path.basename(txtPath)));
        }
      }
    }
    if (jobStore && deliveredNow) {
      markPushedItems(jobStore, pushItems, {
        dateKey: today,
        channelName: group.channelName || "全部",
        draftHash,
        sendMode: shouldSend ? "send" : "draft",
        delivered: deliveredNow,
      });
    }
    if (deliveredNow) markDelivered(state, group.report.priority, group.channelName);
    results.push({
      channelName: group.channelName || "全部",
      mdPath,
      txtPath,
      draftHash,
      recordCount: group.records.length,
      newCount: group.report.newCandidates.length,
      changedCount: group.report.changedCandidates.length,
      priorityCount: group.report.priority.length,
      similarDuplicateCount: group.report.priority.filter((row) => row.similar_duplicate === "是").length,
      delivered: deliveredNow,
      items: pushItems,
      feishu: sendResult,
      email: emailResult,
    });
  }
  updateSeen(state, records);
  saveDisplayIndex(displayIndexPath, displayIndex);
  if (jobStore) saveJobStore(jobStore);
  state.reports.push({
    at: new Date().toISOString(),
    inputPath: resolvedInputPaths.join("; "),
    splitByPlatform,
    messages: results,
    sendMode: shouldSend ? "send" : "draft",
    newCount: results.reduce((sum, item) => sum + item.newCount, 0),
    changedCount: results.reduce((sum, item) => sum + item.changedCount, 0),
    priorityCount: results.reduce((sum, item) => sum + item.priorityCount, 0),
    similarDuplicateCount: results.reduce((sum, item) => sum + item.similarDuplicateCount, 0)
  });
  saveState(state);
  const anyDelivered = results.some((item) => delivered(item.feishu) || delivered(item.email));
  if (shouldSend && !anyDelivered) {
    process.exitCode = 1;
  }
  console.log(JSON.stringify({
    inputPath: resolvedInputPaths.join("; "),
    inputPaths: resolvedInputPaths,
    splitByPlatform,
    messages: results,
    sendMode: shouldSend ? "send" : "draft",
    newCount: results.reduce((sum, item) => sum + item.newCount, 0),
    changedCount: results.reduce((sum, item) => sum + item.changedCount, 0),
    priorityCount: results.reduce((sum, item) => sum + item.priorityCount, 0),
    similarDuplicateCount: results.reduce((sum, item) => sum + item.similarDuplicateCount, 0)
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildReport, deliveryKey, deliverySignature, markDelivered, jobKey };
