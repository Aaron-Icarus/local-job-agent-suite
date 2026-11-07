const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { getSettings, saveSettings } = require("./settings_repo");
const { planTick, getTaskBoard, createCollectionPlan } = require("./task_service");
const roles = require("./role_service");
const scores = require("./scores_repo");
const { listJobs, countJobs } = require("./jobs_repo");
const { loginStatus, recordCheck } = require("./login_monitor");
const { checkPlatform } = require("./login_checker");
const { startChrome } = require("./chrome_manager");
const resumes = require("./resumes_repo");
const ai = require("./ai_providers");
const reports = require("./report_service");
const { buildExcelHtml } = require("./export_service");
const { listNotifications, createNotification } = require("./notifier");
const messagePlatform = require("./message_platform_service");
const chat = require("./chat_service");
const feishuGroups = require("./feishu_groups");
const { listTasks, pauseTask, resumeTask, cancelTask, getTask } = require("./tasks_repo");

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function createAppServer(options = {}) {
  const db = options.db;
  if (!db) throw new Error("缺少数据库");
  const uiDir = options.uiDir || path.join(__dirname, "..", "..", "ui");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname === "/api/health") {
        return json(res, 200, {
          ok: true,
          jobs: countJobs(db),
          roles: roles.listRoles(db).length,
          tasks: listTasks(db, { limit: 5 }).length,
          login: loginStatus(db),
        });
      }
      if (pathname === "/api/settings" && req.method === "GET") {
        return json(res, 200, { ok: true, settings: getSettings(db) });
      }
      if (pathname === "/api/settings" && req.method === "POST") {
        const result = saveSettings(db, await readBody(req));
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === "/api/roles" && req.method === "GET") {
        return json(res, 200, { ok: true, roles: roles.listRoles(db) });
      }

      if (pathname === "/api/chat/sessions" && req.method === "GET") {
        return json(res, 200, { ok: true, sessions: chat.listSessions(db) });
      }
      if (pathname === "/api/chat/sessions" && req.method === "POST") {
        return json(res, 200, { ok: true, session: chat.createSession(db, await readBody(req)) });
      }
      const chatSession = pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
      if (chatSession && req.method === "GET") {
        const session = chat.getSession(db, chatSession[1]);
        if (!session) return json(res, 404, { ok: false, error: "对话不存在" });
        return json(res, 200, { ok: true, session });
      }
      const chatMessage = pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
      if (chatMessage && req.method === "POST") {
        const body = await readBody(req);
        const result = await chat.runTurn(db, chatMessage[1], body);
        return json(res, 200, { ok: true, ...result });
      }
      if (pathname === "/api/roles" && req.method === "POST") {
        const result = roles.createRole(db, await readBody(req));
        const defaultGroup = feishuGroups.applyDefaultGroup(db, result.role.role_uuid);
        return json(res, 200, { ok: true, ...result, defaultGroup });
      }

      if (pathname === "/api/resumes" && req.method === "GET") {
        return json(res, 200, { ok: true, resumes: resumes.listResumes(db) });
      }
      if (pathname === "/api/resumes" && req.method === "POST") {
        return json(res, 200, { ok: true, resume: resumes.importResume(db, await readBody(req)) });
      }
      const resumeId = pathname.match(/^\/api\/resumes\/([^/]+)$/);
      if (resumeId && req.method === "GET") {
        const resume = resumes.getResume(db, resumeId[1]);
        if (!resume) return json(res, 404, { ok: false, error: "简历不存在" });
        return json(res, 200, { ok: true, resume });
      }

      if (pathname === "/api/login/check" && req.method === "POST") {
        const body = await readBody(req);
        const platform = String(body.platform || "");
        const result = await checkPlatform(platform);
        const status = result.ok ? "logged_in" : result.status === "login_required" ? "login_required" : "error";
        const saved = recordCheck(db, platform, status, result.error || "");
        if (!result.ok) {
          await feishuGroups.sendToGroups(db, "login", `【登录异常】${platform}：${status}，请打开客户端检查登录。`);
        }
        return json(res, 200, { ok: result.ok, platform, result, saved });
      }

      if (pathname === "/api/chrome/open" && req.method === "POST") {
        const body = await readBody(req);
        const platform = String(body.platform || "");
        const url = platform === "猎聘" ? "https://c.liepin.com/" : "https://www.zhipin.com/web/geek/jobs";
        const child = startChrome({ startUrl: url, port: Number(body.port || 9222), startMinimized: false });
        return json(res, 200, { ok: true, platform, url, message: "Chrome 已打开登录页", pid: child.child.pid });
      }

      const roleAction = pathname.match(/^\/api\/roles\/([^/]+)\/(confirm|start|pause|copy|delete|update)$/);
      if (roleAction) {
        const [, roleUuid, action] = roleAction;
        const body = await readBody(req);
        if (action === "confirm") {
          return json(res, 200, { ok: true, ...roles.confirmRole(db, roleUuid, body) });
        }
        if (action === "start") return json(res, 200, { ok: true, role: roles.startRole(db, roleUuid) });
        if (action === "pause") return json(res, 200, { ok: true, role: roles.pauseRole(db, roleUuid) });
        if (action === "copy") return json(res, 200, { ok: true, role: roles.copyRole(db, roleUuid, body) });
        if (action === "delete") return json(res, 200, { ok: true, role: roles.softDeleteRole(db, roleUuid) });
        if (action === "update") return json(res, 200, { ok: true, ...roles.updateRole(db, roleUuid, body) });
      }

      if (pathname === "/api/tasks/board" && req.method === "GET") {
        return json(res, 200, { ok: true, ...getTaskBoard(db) });
      }
      if (pathname === "/api/tasks/tick" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, ...planTick(db, { idleAllowed: Boolean(body.idleAllowed) }) });
      }
      if (pathname === "/api/tasks" && req.method === "GET") {
        return json(res, 200, { ok: true, tasks: listTasks(db, { limit: 100 }) });
      }
      const taskAction = pathname.match(/^\/api\/tasks\/(\d+)\/(pause|resume|cancel)$/);
      if (taskAction) {
        const [, id, action] = taskAction;
        if (action === "pause") return json(res, 200, { ok: true, task: pauseTask(db, Number(id)) });
        if (action === "resume") return json(res, 200, { ok: true, task: resumeTask(db, Number(id)) });
        if (action === "cancel") return json(res, 200, { ok: true, task: cancelTask(db, Number(id)) });
      }

      if (pathname === "/api/collection/plan" && req.method === "POST") {
        const body = await readBody(req);
        const plan = createCollectionPlan(db, { forceReason: body.forceReason || "manual" });
        return json(res, 200, { ok: Boolean(plan), ...(plan || {}) });
      }

      if (pathname === "/api/jobs" && req.method === "GET") {
        const roleUuid = url.searchParams.get("role") || "";
        if (roleUuid) {
          const result = scores.searchRoleJobs(db, roleUuid, {
            q: url.searchParams.get("q") || "",
            location: url.searchParams.get("location") || "",
            salaryMin: url.searchParams.get("salaryMin") || "",
            salaryMax: url.searchParams.get("salaryMax") || "",
            dateFrom: url.searchParams.get("dateFrom") || "",
            dateTo: url.searchParams.get("dateTo") || "",
            sort: url.searchParams.get("sort") || "score_desc",
            page: Number(url.searchParams.get("page") || 1),
            pageSize: Number(url.searchParams.get("pageSize") || 20),
          });
          return json(res, 200, { ok: true, ...result });
        }
        return json(res, 200, { ok: true, jobs: listJobs(db, { limit: 100 }) });
      }

      if (pathname === "/api/login/status") {
        return json(res, 200, { ok: true, login: loginStatus(db) });
      }

      if (pathname === "/api/ai/providers" && req.method === "GET") {
        return json(res, 200, { ok: true, providers: ai.listProviders(db) });
      }
      if (pathname === "/api/ai/providers" && req.method === "POST") {
        return json(res, 200, { ok: true, provider: ai.saveProvider(db, await readBody(req)) });
      }
      const aiAction = pathname.match(/^\/api\/ai\/providers\/([^/]+)\/(test|delete)$/);
      if (aiAction) {
        if (aiAction[2] === "delete") {
          return json(res, 200, { ok: true, deleted: ai.deleteProvider(db, aiAction[1]) });
        }
        return json(res, 200, { ok: true, ...(await ai.testProvider(db, aiAction[1])) });
      }

      if (pathname === "/api/reports" && req.method === "GET") {
        return json(res, 200, { ok: true, reports: reports.listReports(db, { limit: 50 }) });
      }
      if (pathname === "/api/reports/build" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, report: reports.buildReport(db, body) });
      }
      const reportSend = pathname.match(/^\/api\/reports\/(\d+)\/send$/);
      if (reportSend) {
        const reportId = Number(reportSend[1]);
        const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
        if (!report) return json(res, 404, { ok: false, error: "日报不存在" });
        const settings = getSettings(db);
        const webhook = settings.feishu_webhook || "";
        const result = await reports.sendReport(db, reportId, {
          sender: async ({ report: item }) => {
            if (!webhook) return { ok: true, skipped: true };
            return reports.sendFeishu(webhook, item.content);
          },
        });
        return json(res, 200, { ok: result.ok, ...result });
      }
      const reportGroups = pathname.match(/^\/api\/reports\/(\d+)\/send-groups$/);
      if (reportGroups) {
        const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(reportGroups[1]));
        if (!report) return json(res, 404, { ok: false, error: "日报不存在" });
        const result = await feishuGroups.sendReportToGroups(db, report);
        return json(res, 200, { ok: result.ok, ...result });
      }

      if (pathname.startsWith("/api/export/") && req.method === "GET") {
        const roleUuid = pathname.split("/").pop();
        const html = buildExcelHtml(db, roleUuid);
        res.writeHead(200, {
          "Content-Type": "application/vnd.ms-excel; charset=utf-8",
          "Content-Disposition": `attachment; filename="jobs-${roleUuid.slice(0, 8)}.xls"`,
        });
        return res.end(`\ufeff${html}`);
      }

      if (pathname === "/api/notifications") {
        return json(res, 200, { ok: true, notifications: listNotifications(db) });
      }

      if (pathname === "/api/messages" && req.method === "GET") {
        const settings = getSettings(db);
        return json(res, 200, {
          ok: true,
          webhook_configured: Boolean(settings.feishu_webhook),
          webhook_masked: settings.feishu_webhook
            ? `${String(settings.feishu_webhook).slice(0, 28)}…`
            : "",
          reports: reports.listReports(db, { limit: 20 }),
          notifications: listNotifications(db, { limit: 30 }),
          original_message_platform: {
            integrated: true,
            path: "消息平台/message-platform",
            note: "已接入配置/启停；原消息平台仍以独立进程运行。",
            status: messagePlatform.status(),
          },
        });
      }
      if (pathname === "/api/message-platform" && req.method === "GET") {
        return json(res, 200, { ok: true, status: messagePlatform.status() });
      }
      if (pathname === "/api/message-platform/config" && req.method === "POST") {
        return json(res, 200, { ok: true, status: messagePlatform.writeEnv(await readBody(req)) && messagePlatform.status() });
      }
      if (pathname === "/api/message-platform/start" && req.method === "POST") {
        return json(res, 200, { ok: true, status: messagePlatform.startService() });
      }
      if (pathname === "/api/message-platform/stop" && req.method === "POST") {
        return json(res, 200, { ok: true, status: messagePlatform.stopService() });
      }
      if (pathname === "/api/message-platform/sync-groups" && req.method === "POST") {
        const groups = feishuGroups.listGroups(db);
        return json(res, 200, {
          ok: true,
          groups: groups.length,
          status: messagePlatform.syncGroups(groups.map((group) => group.chat_id)),
        });
      }

      if (pathname === "/api/feishu-groups" && req.method === "GET") {
        return json(res, 200, { ok: true, groups: feishuGroups.listGroups(db) });
      }
      if (pathname === "/api/feishu-groups" && req.method === "POST") {
        return json(res, 200, { ok: true, group: feishuGroups.saveGroup(db, await readBody(req)) });
      }
      const feishuGroupId = pathname.match(/^\/api\/feishu-groups\/([^/]+)$/);
      if (feishuGroupId && req.method === "DELETE") {
        return json(res, 200, { ok: true, deleted: feishuGroups.deleteGroup(db, feishuGroupId[1]) });
      }
      const feishuGroupTest = pathname.match(/^\/api\/feishu-groups\/([^/]+)\/test$/);
      if (feishuGroupTest && req.method === "POST") {
        return json(res, 200, { ok: true, result: await feishuGroups.testGroup(db, feishuGroupTest[1]) });
      }
      if (pathname === "/api/messages/test" && req.method === "POST") {
        const settings = getSettings(db);
        const webhook = settings.feishu_webhook || "";
        if (!webhook) return json(res, 400, { ok: false, error: "请先保存飞书 webhook" });
        const text = `招聘智能体测试消息\n时间：${new Date().toLocaleString("zh-CN")}`;
        const sent = await reports.sendFeishu(webhook, text);
        const notification = createNotification(db, {
          type: "message_test",
          title: "飞书测试消息",
          body: text,
          channels: ["feishu"],
        });
        db.prepare("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          notification.id
        );
        return json(res, 200, { ok: true, sent, notificationId: notification.id });
      }

      if (req.method === "GET") {
        const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const filePath = path.join(uiDir, relative);
        if (filePath.startsWith(uiDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
          return fs.createReadStream(filePath).pipe(res);
        }
      }
      return json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  });

  return server;
}

function startServer(db, options = {}) {
  const server = createAppServer({ ...options, db });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(options.port || 0), "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { createAppServer, startServer };
