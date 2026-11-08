const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const { getSettings, saveSettings } = require("./settings_repo");
const { planTick, getTaskBoard, createCollectionPlan } = require("./task_service");
const roles = require("./role_service");
const scores = require("./scores_repo");
const { listJobs, countJobs } = require("./jobs_repo");
const { loginStatus, recordCheck } = require("./login_monitor");
const { checkPlatform } = require("./login_checker");
const { ensureChrome, resolveCdpPort, isCdpReady, minimizeChrome } = require("./chrome_manager");
const { extractDocument } = require("./document_text");
const { prepareProfile } = require("./profile_generator");
const { normalizeCities, normalizeSalary } = require("./location_service");
const skillsDir = path.resolve(__dirname, "..", "..", "skills");
const resumes = require("./resumes_repo");
const ai = require("./ai_providers");
const reports = require("./report_service");
const { buildExcelXlsx } = require("./export_service");
const { listNotifications, createNotification, queryNotifications } = require("./notifier");
const messagePlatform = require("./message_platform_service");
const chat = require("./chat_service");
const feishuGroups = require("./feishu_groups");
const logger = require("./logger");
const jobRecheck = require("./job_recheck");
const keywordService = require("./keyword_service");
const { getIdleStatus } = require("./system_idle");
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
      if (body.length > 15 * 1024 * 1024) {
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
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info("http", `${req.method} ${pathname}`, {
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
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
      if (pathname === "/api/logs" && req.method === "GET") {
        return json(res, 200, {
          ok: true,
          stats: logger.stats(),
          logs: logger.tail(Number(url.searchParams.get("limit") || 200)),
        });
      }
      if (pathname === "/api/settings" && req.method === "GET") {
        return json(res, 200, { ok: true, settings: getSettings(db) });
      }
      if (pathname === "/api/settings" && req.method === "POST") {
        const result = saveSettings(db, await readBody(req));
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === "/api/keywords/generate" && req.method === "POST") {
        const body = await readBody(req);
        const result = await chat.generateKeywords(db, body);
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
      const roleKeywordsManual = pathname.match(/^\/api\/roles\/([^/]+)\/keywords\/manual$/);
      if (roleKeywordsManual && req.method === "POST") {
        const body = await readBody(req);
        const keywords = body.action === "remove"
          ? keywordService.removeManual(db, roleKeywordsManual[1], body.keyword)
          : keywordService.addManual(db, roleKeywordsManual[1], body.keyword);
        return json(res, 200, { ok: true, keywords });
      }
      const roleKeywords = pathname.match(/^\/api\/roles\/([^/]+)\/keywords$/);
      if (roleKeywords && req.method === "GET") {
        return json(res, 200, { ok: true, keywords: keywordService.list(db, roleKeywords[1]) });
      }
      const roleKeywordsGenerate = pathname.match(/^\/api\/roles\/([^/]+)\/keywords\/generate$/);
      if (roleKeywordsGenerate && req.method === "POST") {
        const role = roles.getRole(db, roleKeywordsGenerate[1]);
        if (!role) return json(res, 404, { ok: false, error: "角色不存在" });
        const result = await chat.generateKeywords(db, {
          role_uuid: role.role_uuid,
          profile_md: role.profile_md,
          target_roles: role.target_roles,
          target_city: role.target_city,
          target_salary: role.target_salary,
          career_expectation: role.special_requirements,
        });
        return json(res, 200, { ok: true, ...result });
      }
      if (pathname === "/api/roles" && req.method === "POST") {
        const body = await readBody(req);
        const prepared = await prepareProfile(db, body);
        const result = roles.createRole(db, {
          ...body,
          profile_md: prepared.profile_md,
          resume_id: prepared.resume_id || body.resume_id || "",
          profile_status: prepared.profile_status,
        });
        if (body.role_keywords?.length || body.manual_keywords?.length || body.fallback_keywords?.length) {
          const fallback = body.fallback_keywords?.length
            ? body.fallback_keywords
            : (keywordService.extractFallbackFromProfile(prepared.profile_md).length
              ? keywordService.extractFallbackFromProfile(prepared.profile_md)
              : keywordService.fallbackKeywords({ ...body, profile_md: prepared.profile_md }).fallback);
          keywordService.save(db, result.role.role_uuid, {
            recommended: body.role_keywords || [],
            fallback,
          });
          for (const keyword of body.manual_keywords || []) {
            keywordService.addManual(db, result.role.role_uuid, keyword);
          }
        } else {
          await chat.generateKeywords(db, {
            role_uuid: result.role.role_uuid,
            profile_md: prepared.profile_md,
            target_roles: body.target_roles || "",
            target_city: body.target_city || "",
            target_salary: body.target_salary || "",
            career_expectation: body.career_expectation || "",
          });
        }
        const defaultGroup = feishuGroups.applyDefaultGroup(db, result.role.role_uuid);
        return json(res, 200, { ok: true, ...result, profile_status: prepared.profile_status, profile_error: prepared.profile_error, profile_provider: prepared.provider, defaultGroup });
      }
      const roleReprofile = pathname.match(/^\/api\/roles\/([^/]+)\/reprofile$/);
      if (roleReprofile && req.method === "POST") {
        const role = roles.getRole(db, roleReprofile[1]);
        if (!role) return json(res, 404, { ok: false, error: "角色不存在" });
        const resume = role.resume_id ? resumes.getResume(db, role.resume_id) : null;
        if (!resume) return json(res, 400, { ok: false, error: "该角色没有关联简历，请重新上传" });
        const prepared = await prepareProfile(db, {
          resume_md: resume.raw_md,
          resume_id: resume.id,
          nickname: role.nickname,
          target_roles: role.target_roles,
          target_city: role.target_city,
          salary_min: role.salary_min,
          salary_max: role.salary_max,
          profile_md: "",
        });
        const updated = roles.updateRole(db, role.role_uuid, { profile_md: prepared.profile_md, profile_status: prepared.profile_status });
        if (prepared.profile_status === "ready") {
          db.prepare("UPDATE profile_tasks SET status = 'done', updated_at = ? WHERE resume_id = ? AND status = 'pending'")
            .run(new Date().toISOString(), resume.id);
        }
        return json(res, 200, { ok: true, role: updated, ...prepared });
      }
      const roleEdit = pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleEdit && ["PATCH", "PUT"].includes(req.method)) {
        const body = await readBody(req);
        const result = roles.updateRole(db, roleEdit[1], body);
        if (Array.isArray(body.role_keywords)) {
          keywordService.save(db, roleEdit[1], {
            recommended: body.role_keywords,
            fallback: body.fallback_keywords || keywordService.extractFallbackFromProfile(body.profile_md),
          });
        }
        if (Array.isArray(body.manual_keywords)) {
          db.prepare("DELETE FROM role_keyword_entries WHERE role_uuid = ? AND category = 'manual'").run(roleEdit[1]);
          for (const keyword of body.manual_keywords) keywordService.addManual(db, roleEdit[1], keyword);
        }
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === "/api/logs/open" && req.method === "POST") {
        const dir = logger.LOG_DIR;
        fs.mkdirSync(dir, { recursive: true });
        const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
        child.unref();
        return json(res, 200, { ok: true, path: dir });
      }
      if (pathname === "/api/locations/normalize" && req.method === "POST") {
        const body = await readBody(req);
        const location = normalizeCities(body.text || body.cities || "");
        return json(res, 200, { ok: true, ...location });
      }
      if (pathname === "/api/skills" && req.method === "GET") {
        const files = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((item) => item.endsWith(".md")) : [];
        return json(res, 200, { ok: true, path: skillsDir, files });
      }
      if (pathname === "/api/skills/open" && req.method === "POST") {
        if (!fs.existsSync(skillsDir)) return json(res, 404, { ok: false, error: "Skill 文件夹不存在" });
        const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        const child = spawn(command, [skillsDir], { detached: true, stdio: "ignore" });
        child.unref();
        return json(res, 200, { ok: true, path: skillsDir });
      }
      if (pathname === "/api/resume/extract" && req.method === "POST") {
        const body = await readBody(req);
        const fileName = String(body.fileName || "").trim();
        const base64 = String(body.contentBase64 || "").replace(/^data:[^;]+;base64,/, "");
        if (!fileName || !base64) return json(res, 400, { ok: false, error: "缺少文件名或文件内容" });
        try {
          const text = await extractDocument(Buffer.from(base64, "base64"), fileName);
          return json(res, 200, { ok: true, fileName, text, length: text.length });
        } catch (error) {
          return json(res, 422, { ok: false, error: error.message });
        }
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
        const error = result.ok
          ? ""
          : result.status === "login_required"
            ? `${platform} 未登录，请在打开的登录页完成登录后再检查`
            : result.status === "security_check"
              ? `${platform} 出现安全验证，请人工完成验证`
              : `${platform} 登录状态未知，请确认 Chrome 已启动并打开登录页`;
        const httpStatus = result.ok ? 200 : result.status === "login_required" ? 401 : 409;
        return json(res, httpStatus, { ok: result.ok, error, platform, result, saved });
      }

      if (pathname === "/api/chrome/open" && req.method === "POST") {
        const body = await readBody(req);
        const platform = String(body.platform || "");
        const url = platform === "猎聘" ? "https://c.liepin.com/" : "https://www.zhipin.com/web/geek/jobs";
        const chrome = await ensureChrome({
          startUrl: url,
          startMinimized: false,
          port: Number(body.port || 0) || undefined,
        });
        return json(res, 200, {
          ok: true,
          platform,
          url,
          port: chrome.port,
          reused: Boolean(chrome.reused),
          conflict: Boolean(chrome.conflict),
          message: `Chrome CDP 已就绪：127.0.0.1:${chrome.port}`,
          pid: chrome.child?.pid || null,
        });
      }
      if (pathname === "/api/system/idle" && req.method === "GET") {
        return json(res, 200, { ok: true, ...(await getIdleStatus({ thresholdSeconds: 120 })) });
      }
      if (pathname === "/api/chrome/minimize" && req.method === "POST") {
        const resolved = await resolveCdpPort();
        const minimized = await minimizeChrome(resolved.port);
        return json(res, 200, { ok: minimized, port: resolved.port, minimized });
      }
      if (pathname === "/api/chrome/status" && req.method === "GET") {
        const resolved = await resolveCdpPort();
        return json(res, 200, {
          ok: true,
          port: resolved.port,
          ready: await isCdpReady(resolved.port),
          reused: resolved.reused,
          conflict: Boolean(resolved.conflict),
        });
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
        return json(res, 200, { ok: true, ...planTick(db, { idleAllowed: Boolean(body.idleAllowed), forceReason: body.forceReason || "" }) });
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

      if (pathname === "/api/jobs/recheck/status" && req.method === "GET") {
        return json(res, 200, { ok: true, status: jobRecheck.getStatus(), batches: jobRecheck.listBatches(db, 5) });
      }
      if (pathname === "/api/jobs/recheck/candidates" && req.method === "GET") {
        const items = jobRecheck.candidates(db);
        return json(res, 200, { ok: true, count: items.length, jobs: items.map((job) => ({
          displayId: job.display_id, company: job.company, title: job.title,
          lastSeenDate: job.last_seen_date, lastRecheckAt: job.last_recheck_at,
        })) });
      }
      if (pathname === "/api/jobs/recheck" && req.method === "POST") {
        const body = await readBody(req);
        if (body.action === "cancel") return json(res, 200, { ok: true, ...jobRecheck.cancelRecheck() });
        return json(res, 200, { ok: true, ...jobRecheck.startRecheck(db) });
      }
      if (pathname === "/api/jobs/recheck/batches" && req.method === "GET") {
        return json(res, 200, { ok: true, batches: jobRecheck.listBatches(db) });
      }
      const jobDetail = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobDetail && req.method === "GET") {
        const roleUuid = url.searchParams.get("role") || "";
        const row = db.prepare(
          `SELECT j.*, rj.score, rj.tier, rj.score_time, rj.score_explanation, rj.score_reasons_json,
                  rj.score_risks_json, rj.note, rj.greeting_status, rj.score_version
           FROM jobs j
           LEFT JOIN role_jobs rj ON rj.job_uuid = j.job_uuid AND rj.role_uuid = ?
           WHERE j.job_uuid = ?`
        ).get(roleUuid, jobDetail[1]);
        if (!row) return json(res, 404, { ok: false, error: "岗位不存在" });
        return json(res, 200, { ok: true, job: row });
      }
      if (pathname === "/api/open-url" && req.method === "POST") {
        const body = await readBody(req);
        const target = String(body.url || "").trim();
        if (!/^https?:\/\//i.test(target)) return json(res, 400, { ok: false, error: "只允许打开 http/https 链接" });
        const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        return json(res, 200, { ok: true, url: target });
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
        const result = buildExcelXlsx(db, roleUuid);
        const fileName = result.filename.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Content-Length": result.buffer.length,
        });
        return res.end(result.buffer);
      }

      if (pathname === "/api/notifications") {
        const url = new URL(req.url, "http://127.0.0.1");
        const result = queryNotifications(db, {
          q: url.searchParams.get("q") || "",
          from: url.searchParams.get("from") || "",
          to: url.searchParams.get("to") || "",
          page: url.searchParams.get("page") || 1,
          pageSize: url.searchParams.get("page_size") || 10,
        });
        return json(res, 200, { ok: true, notifications: result.items, total: result.total, page: result.page, pageSize: result.pageSize, pages: result.pages });
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

      if (pathname === "/api/feishu-routing/stage" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, ...feishuGroups.setRoleStageGroup(db, body.roleUuid, body.stage, body.groupId || "") });
      }
      if (pathname === "/api/feishu-routing" && req.method === "GET") {
        return json(res, 200, { ok: true, ...feishuGroups.routing(db) });
      }
      if (pathname === "/api/feishu-routing" && req.method === "POST") {
        const body = await readBody(req);
        const group = feishuGroups.routeRole(db, body.roleUuid, body.groupId, body);
        return json(res, 200, { ok: true, group, ...feishuGroups.routing(db) });
      }
      if (pathname === "/api/feishu-groups/default" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, group: feishuGroups.setDefaultGroup(db, body.groupId) });
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
      logger.error("http", `${req.method} ${pathname} 失败：${error.message}`);
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
