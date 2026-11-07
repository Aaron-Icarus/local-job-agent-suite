const state = {
  roles: [],
  settings: {},
  tasks: [],
  events: [],
  jobs: [],
  providers: [],
  reports: [],
  activeRole: "",
  confirmRoleId: "",
  resumeContent: "",
  resumeFileName: "",
  jobPage: 1,
  jobPageSize: 20,
  jobTotal: 0,
  jobPages: 1,
  chatSessionId: "",
  chatSessions: [],
  chatSuggestions: [],
  chatResumeContent: "",
  chatResumeFileName: "",
  feishuGroups: [],
  editingGroupId: "",
  recheckPolling: false,
  recheckTimer: null,
  keywordRoleUuid: "",
  editRoleUuid: "",
  deleteGroupId: "",
  routeGroupRole: "",
  routeGroupStage: "",
  notificationPage: 1,
  notificationPages: 1,
  notificationPageSize: 10,
  historyNotifications: [],
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
}

function tag(text, cls = "") {
  return `<span class="tag ${cls}">${esc(text)}</span>`;
}

function showLog(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function toast(message, bad = false) {
  const el = document.getElementById("healthBadge");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("bad", bad);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(refreshHealth, 3000);
}

async function refreshHealth() {
  try {
    const data = await api("/api/health");
    const el = document.getElementById("healthBadge");
    el.textContent = `已连接 · ${data.jobs} 岗位 · ${data.roles} 角色`;
    el.classList.remove("bad");
    const cards = document.getElementById("dashboardCards");
    if (cards) {
      cards.innerHTML = `
        <div class="card"><div class="num">${data.jobs}</div><div class="label">岗位总数</div></div>
        <div class="card"><div class="num">${data.roles}</div><div class="label">角色</div></div>
        <div class="card"><div class="num">${data.tasks ?? 0}</div><div class="label">最近任务</div></div>
      `;
    }
    renderChannels(data.login || []);
    return data;
  } catch (error) {
    const el = document.getElementById("healthBadge");
    el.textContent = `未连接：${error.message}`;
    el.classList.add("bad");
    return null;
  }
}

function renderChannels(login) {
  const container = document.getElementById("channelCards");
  if (!container) return;
  const items = ["BOSS", "猎聘"].map((platform) => {
    const item = login.find((entry) => entry.platform === platform) || {};
    const last = item.last;
    const status = last?.status || "未检查";
    const ok = status === "logged_in";
    const bad = ["login_required", "error"].includes(status);
    return `
      <div class="channel">
        <div>
          <div class="name"><span class="dot ${ok ? "ok" : bad ? "bad" : "warn"}"></span>${platform}</div>
          <div class="meta">${ok ? "已登录" : bad ? "需要登录" : "未检查/未知"} · ${last?.checked_at ? "上次 " + fmt(last.checked_at) : "尚未检查"}</div>
        </div>
        <div class="actions">
          <button class="small ghost" data-channel-check="${platform}">检查登录</button>
          <button class="small" data-channel-open="${platform}">打开登录页</button>
        </div>
      </div>`;
  });
  container.innerHTML = items.join("");
}

async function refreshRoles() {
  const data = await api("/api/roles");
  state.roles = data.roles || [];
  const list = document.getElementById("roleList");
  if (!state.roles.length) {
    list.innerHTML = '<div class="empty">还没有角色，先创建一个。</div>';
  } else {
    list.innerHTML = state.roles.map((role) => {
      const channels = (role.role_channels || []).join(" / ") || "未选渠道";
      return `
      <div class="row">
        <div>
          <strong>${esc(role.role_number)} · ${esc(role.nickname)}</strong>
          ${tag(role.status, role.status === "running" ? "ok" : role.status === "pending_confirm" ? "warn" : "")}
          <div class="meta">${esc(role.target_roles || "未设置目标岗位")} · 渠道：${esc(channels)} · 待评分 ${role.pending_scores ?? "-"} · ${role.has_started ? "已锁定" : "可修改"}</div>
        </div>
        <div class="actions">
          ${role.status === "pending_confirm" ? `<button class="small" data-action="confirm" data-id="${role.role_uuid}">确认渠道</button>` : ""}
          ${role.status === "pending_confirm" ? `<button class="small ghost" data-edit-role="${role.role_uuid}">修改</button>` : ""}
          ${["pending_start", "paused"].includes(role.status) ? `<button class="small" data-action="start" data-id="${role.role_uuid}">启动</button>` : ""}
          ${role.status === "running" ? `<button class="small ghost" data-action="pause" data-id="${role.role_uuid}">暂停</button>` : ""}
          <button class="small ghost" data-action="copy" data-id="${role.role_uuid}">复制</button>
          <button class="small ghost" data-keywords="${role.role_uuid}">关键词</button>
          <button class="small danger" data-action="delete" data-id="${role.role_uuid}">删除</button>
        </div>
      </div>`;
    }).join("");
  }
  const options = state.roles.map((role) => `<option value="${role.role_uuid}">${esc(role.role_number)} ${esc(role.nickname)}</option>`).join("");
  for (const id of ["jobRoleSelect", "reportRoleSelect", "chatRoleSelect"]) {
    const select = document.getElementById(id);
    if (select) {
      select.innerHTML = options || '<option value="">无角色</option>';
      if (!select.value && state.roles[0]) select.value = state.roles[0].role_uuid;
    }
  }
  state.activeRole = document.getElementById("jobRoleSelect")?.value || state.roles[0]?.role_uuid || "";
}

async function refreshTasks() {
  const data = await api("/api/tasks/board");
  state.tasks = data.tasks || [];
  state.events = data.collectionEvents || [];
  let idle = { available: false };
  try { idle = await api("/api/system/idle"); } catch { /* 忽略空闲检测失败 */ }
  const summary = document.getElementById("taskSummary");
  const running = state.tasks.filter((task) => task.status === "running").length;
  const queued = state.tasks.filter((task) => ["queued", "retrying"].includes(task.status)).length;
  summary.innerHTML = `
    <div class="card"><div class="num">${running}</div><div class="label">运行中</div></div>
    <div class="card"><div class="num">${queued}</div><div class="label">排队/重试</div></div>
    <div class="card"><div class="num">${state.events.length}</div><div class="label">采集事件</div></div>
    <div class="card"><div class="num">${data.runningCollection ? "是" : "否"}</div><div class="label">采集运行中</div></div>
    <div class="card"><div class="num">${idle.available ? (idle.active ? "使用中" : "空闲") : "未知"}</div><div class="label">电脑状态</div></div>
  `;
  const list = document.getElementById("taskList");
  const pendingTasks = state.tasks.filter((task) => ["queued", "running", "paused", "retrying", "stalled"].includes(task.status));
  const historyTasks = state.tasks.filter((task) => !["queued", "running", "paused", "retrying", "stalled"].includes(task.status));
  list.innerHTML = pendingTasks.length ? pendingTasks.map((task) => `
    <div class="row">
      <div>
        <strong>#${task.id} ${esc(task.type)}</strong> ${tag(task.status, task.status === "succeeded" ? "ok" : task.status === "failed" ? "bad" : "warn")}
        <div class="meta">优先级 ${task.priority} · 尝试 ${task.attempts} · ${esc(fmt(task.updated_at))} ${task.last_error ? "· " + esc(task.last_error) : ""}</div>
      </div>
      <div class="actions">
        ${task.status === "running" ? `<button class="small ghost" data-task="pause" data-id="${task.id}">暂停</button>` : ""}
        ${task.status === "paused" ? `<button class="small" data-task="resume" data-id="${task.id}">继续</button>` : ""}
        ${["queued", "running", "paused"].includes(task.status) ? `<button class="small danger" data-task="cancel" data-id="${task.id}">关闭</button>` : ""}
      </div>
    </div>`).join("") : '<div class="empty">暂无待处理任务</div>';
  const historyList = document.getElementById("historyTaskList");
  historyList.innerHTML = historyTasks.length ? historyTasks.map((task) => `
    <div class="row">
      <div>
        <strong>#${task.id} ${esc(task.type)}</strong> ${tag(task.status, task.status === "succeeded" ? "ok" : "bad")}
        <div class="meta">${esc(fmt(task.updated_at))}${task.last_error ? " · " + esc(task.last_error) : ""}</div>
      </div>
    </div>`).join("") : '<div class="empty">暂无历史任务</div>';
  const events = document.getElementById("eventList");
  const activeEvents = state.events.filter((event) => ["queued", "running"].includes(event.status));
  const historyEvents = state.events.filter((event) => !["queued", "running"].includes(event.status));
  const renderEvent = (event) => `<div class="row"><div><strong>事件 #${event.id}</strong> ${tag(event.status, event.status === "success" ? "ok" : event.status === "failed" ? "bad" : "warn")}<div class="meta">${esc(event.event_date)} · 子任务成功 ${event.success_subtasks} / 失败 ${event.failed_subtasks} · ${esc(event.force_reason || "常规")}</div></div></div>`;
  events.innerHTML = activeEvents.length ? activeEvents.map(renderEvent).join("") : '<div class="empty">暂无进行中的采集事件</div>';
  document.getElementById("historyEventList").innerHTML = historyEvents.length ? historyEvents.map(renderEvent).join("") : '<div class="empty">暂无历史采集事件</div>';
}

async function refreshJobs() {
  const roleUuid = document.getElementById("jobRoleSelect")?.value || state.activeRole;
  if (!roleUuid) {
    document.getElementById("jobList").innerHTML = '<div class="empty">先创建角色。</div>';
    return;
  }
  const params = new URLSearchParams({
    role: roleUuid,
    q: document.getElementById("jobSearch").value.trim(),
    location: document.getElementById("jobLocation").value.trim(),
    salaryMin: document.getElementById("jobSalaryMin").value.trim(),
    salaryMax: document.getElementById("jobSalaryMax").value.trim(),
    dateFrom: document.getElementById("jobDateFrom").value,
    dateTo: document.getElementById("jobDateTo").value,
    sort: document.getElementById("jobSort").value,
    page: String(state.jobPage),
    pageSize: String(state.jobPageSize),
  });
  const data = await api(`/api/jobs?${params.toString()}`);
  state.jobs = data.jobs || [];
  state.jobTotal = data.total || 0;
  state.jobPages = data.pages || 1;
  state.jobPage = data.page || 1;
  document.getElementById("jobTotal").textContent = `共 ${state.jobTotal} 条 · 第 ${state.jobPage}/${state.jobPages} 页`;
  const list = document.getElementById("jobList");
  list.innerHTML = state.jobs.length ? state.jobs.map((job) => `
    <div class="row">
      <div>
        <strong>${esc(job.display_id)} ${esc(job.company || "")} · ${esc(job.title || "")}</strong>
        ${tag(job.job_status || job.main_job_status || "open", (job.job_status || job.main_job_status) === "closed" ? "bad" : "ok")}
        ${(job.duplicate_status || job.main_duplicate_status) === "duplicate" ? tag("重复", "bad") : ""}
        <div class="meta">${esc(job.salary_text || "-")} · ${esc(job.city || "-")}${job.district ? " " + esc(job.district) : ""} · 采集 ${esc(job.first_seen_date || "-")} ~ ${esc(job.last_seen_date || "-")} · 评分 ${job.score ?? "-"} ${esc(job.tier || "")}${job.last_recheck_at ? " · 总刷 " + esc(job.last_recheck_at) : ""}</div>
      </div>
      <div class="actions">
        ${job.job_url ? `<a class="small" href="${esc(job.job_url)}" target="_blank" rel="noreferrer">打开岗位</a>` : ""}
      </div>
    </div>`).join("") : '<div class="empty">没有符合条件的岗位。</div>';
  renderJobPager();
}

function renderJobPager() {
  const pager = document.getElementById("jobPager");
  if (!pager) return;
  const total = state.jobPages;
  const current = state.jobPage;
  const pages = new Set([1, total, current - 1, current, current + 1]);
  for (let i = 2; i <= 4; i += 1) pages.add(i);
  for (let i = total - 3; i < total; i += 1) if (i > 0) pages.add(i);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const buttons = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) buttons.push('<span class="hint">…</span>');
    buttons.push(`<button class="small ${page === current ? "active" : "ghost"}" data-page="${page}">${page}</button>`);
    previous = page;
  }
  pager.innerHTML = `
    <button class="small ghost" data-page="${Math.max(1, current - 1)}" ${current <= 1 ? "disabled" : ""}>上一页</button>
    ${buttons.join("")}
    <button class="small ghost" data-page="${Math.min(total, current + 1)}" ${current >= total ? "disabled" : ""}>下一页</button>
    <span class="hint">跳到</span><input id="jobJump" type="number" min="1" max="${total}" value="${current}">
    <button class="small" id="btnJobJump">跳转</button>
  `;
}

async function refreshSettings() {
  const data = await api("/api/settings");
  state.settings = data.settings || {};
  const s = state.settings;
  document.getElementById("setDays").value = s.collection_days || "weekdays";
  document.getElementById("setStart").value = s.collection_start || "09:00";
  document.getElementById("setEnd").value = s.collection_end || "18:00";
  document.getElementById("setMinRuns").value = s.min_collection_runs ?? 2;
  document.getElementById("setInterval").value = s.min_interval_hours ?? 3;
  document.getElementById("setReportTime").value = s.report_time || "21:00";
  document.getElementById("setIdle").value = s.idle_minutes ?? 5;
  document.getElementById("setCpu").value = s.cpu_max_percent ?? 30;
  document.getElementById("setBattery").value = s.battery_min_percent ?? 30;
  document.getElementById("setCollectAtIngest").value = String(Boolean(s.collect_at_ingest));
  document.getElementById("setFeishu").value = s.feishu_webhook || "";
}

async function refreshProviders() {
  const data = await api("/api/ai/providers");
  state.providers = data.providers || [];
  const list = document.getElementById("aiList");
  list.innerHTML = state.providers.length ? state.providers.map((provider) => `
    <div class="row">
      <div>
        <strong>${esc(provider.name)}</strong> ${tag(provider.enabled ? "启用" : "关闭", provider.enabled ? "ok" : "")}
        <div class="meta">${esc(provider.type)} · ${esc(provider.base_url || provider.command || "-")} · ${esc(provider.model || "")} · ${provider.has_key ? "已配置 Key" : "未配置 Key"}</div>
      </div>
      <div class="actions">
        <button class="small ghost" data-ai="test" data-id="${provider.id}">测试</button>
        <button class="small danger" data-ai="delete" data-id="${provider.id}">删除</button>
      </div>
    </div>`).join("") : '<div class="empty">还没有 AI 供应商；可先用规则兜底。</div>';
}

async function refreshReports() {
  const data = await api("/api/reports");
  state.reports = data.reports || [];
  document.getElementById("reportList").innerHTML = state.reports.length ? state.reports.map((report) => `
    <div class="row">
      <div>
        <strong>${esc(report.report_date)}</strong> ${tag(report.status, report.status === "sent" ? "ok" : "warn")}
        <div class="meta">${esc((report.content || "").split("\n")[0] || "")}</div>
      </div>
      <div class="actions">
        <button class="small ghost" data-report="${report.id}">查看</button>
        <button class="small" data-report-groups="${report.id}">发到群</button>
      </div>
    </div>`).join("") : '<div class="empty">还没有日报。</div>';
}

async function refreshMessages() {
  const data = await api("/api/messages");
  const input = document.getElementById("msgWebhook");
  if (input) input.value = state.settings.feishu_webhook || "";
  const status = document.getElementById("msgStatus");
  if (status) {
    status.textContent = data.webhook_configured
      ? `已配置：${data.webhook_masked || "webhook"}`
      : "未配置 webhook；日报/测试消息无法发送。";
  }
  const list = document.getElementById("messageLog");
  if (list) {
    const items = data.notifications || [];
    state.notifications = items;
    list.innerHTML = items.length ? items.map((item) => `
      <div class="row" data-notification="${item.id}" style="cursor:pointer">
        <div>
          <strong>${esc(item.title || item.type)}</strong> ${tag(item.status, item.status === "sent" ? "ok" : item.status === "failed" ? "bad" : "warn")}
          <div class="meta">${esc(item.type)} · ${esc(fmt(item.created_at))} ${item.body ? "· " + esc(item.body).slice(0, 120) : ""}</div>
        </div>
      </div>`).join("") : '<div class="empty">还没有通知记录。</div>';
  }
  const mp = data.original_message_platform?.status;
  if (mp) {
    const mpStatus = document.getElementById("mpStatus");
    if (mpStatus) {
      mpStatus.textContent = `${mp.running ? "运行中" : "未运行"} · AppID ${mp.appIdConfigured ? "已配置" : "未配置"} · Secret ${mp.secretConfigured ? "已配置" : "未配置"} · 群ID ${mp.chatIdConfigured ? "已配置" : "未配置"}`;
    }
    const mpLog = document.getElementById("mpLog");
    if (mpLog) mpLog.textContent = mp.logTail || "暂无日志";
    const chatInput = document.getElementById("mpChatId");
    if (chatInput && mp.chatId) chatInput.value = mp.chatId;
  }
}

async function refreshNotificationHistory() {
  const q = document.getElementById("notificationSearch")?.value.trim() || "";
  const from = document.getElementById("notificationFrom")?.value || "";
  const to = document.getElementById("notificationTo")?.value || "";
  const pageSize = Number(document.getElementById("notificationPageSize")?.value || state.notificationPageSize || 10);
  const data = await api(`/api/notifications?q=${encodeURIComponent(q)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${state.notificationPage}&page_size=${pageSize}`);
  state.historyNotifications = data.notifications || [];
  state.notificationPage = data.page || 1;
  state.notificationPages = data.pages || 1;
  state.notificationPageSize = data.pageSize || pageSize;
  const list = document.getElementById("notificationHistoryList");
  if (list) {
    list.innerHTML = state.historyNotifications.length ? state.historyNotifications.map((item) => `
      <div class="row" data-notification="${item.id}" style="cursor:pointer">
        <div>
          <strong>${esc(item.title || item.type)}</strong> ${tag(item.status, item.status === "sent" ? "ok" : item.status === "failed" ? "bad" : "warn")}
          <div class="meta">${esc(item.type)} · ${esc(fmt(item.created_at))} ${item.body ? "· " + esc(item.body).slice(0, 180) : ""}</div>
        </div>
      </div>`).join("") : '<div class="empty">没有匹配的历史通知。</div>';
  }
  document.getElementById("notificationPageInfo").textContent = `第 ${state.notificationPage} / ${state.notificationPages} 页 · 共 ${data.total || 0} 条`;
  document.getElementById("btnNotificationPrev").disabled = state.notificationPage <= 1;
  document.getElementById("btnNotificationNext").disabled = state.notificationPage >= state.notificationPages;
}

async function refreshChatSessions() {
  const data = await api("/api/chat/sessions");
  state.chatSessions = data.sessions || [];
  const list = document.getElementById("chatSessions");
  if (!list) return;
  list.innerHTML = state.chatSessions.length ? state.chatSessions.map((session) => `
    <div class="row">
      <div>
        <strong>${esc(session.title || "对话")}</strong>
        <div class="meta">${esc(fmt(session.updated_at))}</div>
      </div>
      <div class="actions"><button class="small ghost" data-chat-session="${session.id}">打开</button></div>
    </div>`).join("") : '<div class="empty">还没有对话。</div>';
  if (!state.chatSessionId && state.chatSessions[0]) {
    await loadChatSession(state.chatSessions[0].id);
  }
}

function renderChat(session) {
  const container = document.getElementById("chatMessages");
  if (!container) return;
  state.chatSuggestions = [];
  if (!session || !session.messages?.length) {
    container.innerHTML = '<div class="empty">上传简历或直接提问。例如：“帮我生成角色画像：实施顾问，上海，18-25K，5 年经验”。</div>';
    return;
  }
  container.innerHTML = session.messages.map((message) => {
    const meta = message.metadata || {};
    let extra = "";
    if (meta.action === "profile_ready" && meta.suggested) {
      const index = state.chatSuggestions.push(meta.suggested) - 1;
      extra = `<div class="meta"><button class="small" data-chat-create-role="${index}">用此画像创建角色</button></div>`;
    }
    if (meta.action === "job_search" && meta.jobs?.length) {
      extra = `<div class="meta">岗位编号：${meta.jobs.map((job) => esc(job.id)).join("、")}</div>`;
    }
    return `<div class="chat-bubble ${message.role === "user" ? "user" : "assistant"}">${esc(message.content)}${extra ? `<div class="meta">${extra}</div>` : ""}</div>`;
  }).join("");
  container.scrollTop = container.scrollHeight;
}

async function ensureChatSession() {
  if (state.chatSessionId) return state.chatSessionId;
  const roleUuid = document.getElementById("chatRoleSelect")?.value || "";
  const result = await api("/api/chat/sessions", {
    method: "POST",
    body: { title: "角色画像对话", roleUuid },
  });
  state.chatSessionId = result.session.id;
  return state.chatSessionId;
}

async function loadChatSession(id) {
  const result = await api(`/api/chat/sessions/${id}`);
  state.chatSessionId = id;
  renderChat(result.session);
}

async function sendChat() {
  const text = document.getElementById("chatInput").value.trim();
  if (!text && !state.chatResumeContent) return;
  const sessionId = await ensureChatSession();
  const result = await api(`/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    body: {
      text,
      resume_md: state.chatResumeContent || undefined,
      resume_file_name: state.chatResumeFileName || undefined,
      roleUuid: document.getElementById("chatRoleSelect")?.value || undefined,
    },
  });
  state.chatResumeContent = "";
  state.chatResumeFileName = "";
  document.getElementById("chatResumeFile").value = "";
  document.getElementById("chatInput").value = "";
  renderChat(result.session);
  await refreshChatSessions();
}

async function refreshGroups() {
  const data = await api("/api/feishu-groups");
  state.feishuGroups = data.groups || [];
  const list = document.getElementById("groupCards");
  if (!list) return;
  const statusLabel = { normal: "正常", error: "异常", disabled: "停用", untested: "未测试" };
  list.innerHTML = state.feishuGroups.length ? state.feishuGroups.map((group) => {
    const status = group.status || (group.enabled ? "untested" : "disabled");
    return `<div class="group-card status-${status}">
      <div class="group-card-head">
        <strong>${esc(group.name)}</strong>
        <span class="tag ${status === "normal" ? "ok" : status === "error" ? "bad" : "warn"}">${statusLabel[status] || status}</span>
        ${group.is_default ? '<span class="tag ok">默认</span>' : ""}
      </div>
      <div class="meta">Chat ID：${esc(group.chat_id)}</div>
      <div class="meta">${group.last_test_at ? `最近测试：${esc(fmt(group.last_test_at))}` : "尚未测试"}</div>
      <div class="group-card-actions">
        <button class="small ghost" data-test-group="${group.id}">测试</button>
        <button class="small ghost" data-edit-group="${group.id}">重命名</button>
        <button class="small danger" data-delete-group="${group.id}">删除</button>
      </div>
    </div>`;
  }).join("") : '<div class="empty">还没有飞书群。点击“添加群”开始注册。</div>';
}

async function refreshRouting() {
  const data = await api("/api/feishu-routing");
  const groups = data.groups || [];
  const groupOptions = (selected) => `<option value="">不发送</option>` + groups.map((group) => `<option value="${group.id}"${selected === group.id ? " selected" : ""}>${esc(group.name)}</option>`).join("");
  const body = document.getElementById("routeStageBody");
  if (!body) return;
  const stages = [["login", "登录状态"], ["error", "操作异常"], ["daily", "每日日报"]];
  const rows = [`<tr class="route-default-row">
    <td><strong>默认通知群</strong></td>
    <td>所有新角色</td>
    <td><select id="routingDefaultGroup">${groupOptions(data.defaultGroupId)}</select></td>
    <td><span class="hint">自动加入</span></td>
  </tr>`];
  for (const role of data.roles || []) {
    for (const [stageKey, stageLabel] of stages) {
      const stage = role.stages?.[stageKey] || { groupId: "", groupName: "" };
      rows.push(`<tr>
        <td>${esc(role.role_number)} ${esc(role.nickname)}</td>
        <td>${stageLabel}</td>
        <td>${stage.groupName ? esc(stage.groupName) : '<span class="hint">不发送</span>'}</td>
        <td><button class="small ghost" data-route-role="${role.role_uuid}" data-route-stage="${stageKey}" data-route-label="${esc(role.role_number)} ${esc(role.nickname)} / ${stageLabel}">一键填充</button></td>
      </tr>`);
    }
  }
  body.innerHTML = rows.join("");
}

function openEditRole(roleUuid) {
  const role = state.roles.find((item) => item.role_uuid === roleUuid);
  if (!role) return;
  state.editRoleUuid = roleUuid;
  document.getElementById("editRoleNickname").value = role.nickname || "";
  document.getElementById("editRoleProfile").value = role.profile_md || "";
  document.getElementById("editRoleTargets").value = role.target_roles || "";
  document.getElementById("editRoleCity").value = role.target_city || "";
  document.getElementById("editRoleSalary").value = role.target_salary || "";
  document.getElementById("editRoleKeywords").value = (role.role_keywords || []).join("、");
  document.getElementById("editRoleDialog").showModal();
}

async function openKeywordDialog(roleUuid) {  state.keywordRoleUuid = roleUuid;
  const data = await api(`/api/roles/${roleUuid}/keywords`);
  const entries = data.keywords || [];
  const current = entries.filter((item) => item.is_current);
  const renderGroup = (category, label) => {
    const rows = current.filter((item) => item.category === category);
    return `<h2>${label}</h2>${rows.length ? rows.map((item) => `<div class="row"><div><strong>${esc(item.keyword)}</strong><div class="meta">使用 ${item.use_count || 0} 次 · 新增 ${item.new_count || 0} · 重复 ${item.duplicate_count || 0} · 失败 ${item.failed_count || 0}${item.last_used_at ? " · 上次 " + esc(item.last_used_at) : ""}</div></div></div>`).join("") : '<div class="empty">暂无</div>'}`;
  };
  document.getElementById("keywordList").innerHTML = renderGroup("recommended", "下一轮推荐") + renderGroup("fallback", "默认兜底");
  document.getElementById("keywordDialog").showModal();
}

async function generateRoleKeywords() {
  if (!state.keywordRoleUuid) return;
  const result = await api(`/api/roles/${state.keywordRoleUuid}/keywords/generate`, { method: "POST", body: {} });
  await openKeywordDialog(state.keywordRoleUuid);
  toast(result.aiUsed ? "AI 已生成下一轮关键词" : "已用本地规则生成关键词");
}

function resetGroupForm() {
  state.editingGroupId = "";
  for (const id of ["groupName", "groupChatId", "groupWebhook"]) {
    const input = document.getElementById(id);
    if (input) input.value = "";
  }
  const title = document.getElementById("groupDialogTitle");
  if (title) title.textContent = "添加飞书群";
}

async function refreshAll() {
  await refreshHealth();
  try {
    await refreshRoles();
    await refreshTasks();
    await refreshJobs();
    await refreshSettings();
    await refreshProviders();
    await refreshReports();
    await refreshMessages();
    await refreshNotificationHistory().catch(() => {});
    await refreshGroups();
    await refreshRouting();
    await refreshChatSessions();
    showLog("dashboardLog", "就绪：可执行一次调度，或先创建角色并启动任务。");
  } catch (error) {
    toast(`加载失败：${error.message}`, true);
  }
}

function openConfirmDialog(roleUuid) {
  const role = state.roles.find((item) => item.role_uuid === roleUuid);
  if (!role) return;
  state.confirmRoleId = roleUuid;
  const channels = role.role_channels || [];
  document.getElementById("confirmBoss").checked = channels.length ? channels.includes("BOSS") : true;
  document.getElementById("confirmLiepin").checked = channels.length ? channels.includes("猎聘") : true;
  document.getElementById("confirmDialog").showModal();
}

function activateTab(tab) {
  const name = tab || "dashboard";
  document.querySelectorAll(".tabs button").forEach((item) => item.classList.toggle("active", item.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${name}`));
}

function bind() {
  document.getElementById("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button) return;
    location.hash = button.dataset.tab;
    activateTab(button.dataset.tab);
  });
  window.addEventListener("hashchange", () => activateTab(location.hash.slice(1)));
  activateTab(location.hash.slice(1));

  document.getElementById("chatResumeFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    state.chatResumeContent = await file.text();
    state.chatResumeFileName = file.name;
    toast(`已选择简历：${file.name}`);
  });
  document.getElementById("btnNewChat").onclick = () => {
    state.chatSessionId = "";
    state.chatSuggestions = [];
    renderChat(null);
  };
  document.getElementById("btnChatSend").onclick = async () => {
    try { await sendChat(); } catch (error) { alert(error.message); }
  };
  document.getElementById("chatInput").addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      try { await sendChat(); } catch (error) { alert(error.message); }
    }
  });
  document.getElementById("chatSessions").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-chat-session]");
    if (!button) return;
    try { await loadChatSession(button.dataset.chatSession); } catch (error) { alert(error.message); }
  });
  document.getElementById("chatMessages").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-chat-create-role]");
    if (!button) return;
    const suggested = state.chatSuggestions[Number(button.dataset.chatCreateRole)];
    if (!suggested) return;
    try {
      const result = await api("/api/roles", {
        method: "POST",
        body: {
          nickname: suggested.nickname || "聊天创建角色",
          profile_md: suggested.profile_md,
          target_roles: suggested.target_roles,
          target_city: suggested.target_city,
          target_salary: suggested.target_salary,
          role_keywords: suggested.role_keywords || [],
          fallback_keywords: suggested.fallback_keywords || [],
        },
      });
      await refreshRoles();
      toast(`角色 ${result.role.role_number} 已创建，请确认渠道`);
    } catch (error) { alert(error.message); }
  });

  document.getElementById("btnResetGroup").onclick = resetGroupForm;
  document.getElementById("btnSyncGroups").onclick = async () => {
    try {
      const result = await api("/api/message-platform/sync-groups", { method: "POST", body: {} });
      await refreshMessages();
      toast(`已同步 ${result.groups} 个群到消息平台，重启服务生效`);
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnAddGroup").onclick = () => {
    resetGroupForm();
    document.getElementById("groupDialogTitle").textContent = "添加飞书群";
    document.getElementById("groupDialog").showModal();
  };
  document.getElementById("btnCloseGroupDialog").onclick = () => document.getElementById("groupDialog").close();
  document.getElementById("btnGroupHelp").onclick = () => document.getElementById("helpDialog").showModal();
  document.getElementById("btnCloseHelp").onclick = () => document.getElementById("helpDialog").close();
  document.getElementById("btnCloseNotification").onclick = () => document.getElementById("notificationDialog").close();
  document.getElementById("btnCloseKeywords").onclick = () => document.getElementById("keywordDialog").close();
  document.getElementById("btnCancelRoleEdit").onclick = () => document.getElementById("editRoleDialog").close();
  document.getElementById("btnSaveRoleEdit").onclick = async () => {
    if (!state.editRoleUuid) return;
    try {
      await api(`/api/roles/${state.editRoleUuid}`, {
        method: "PATCH",
        body: {
          nickname: document.getElementById("editRoleNickname").value.trim(),
          profile_md: document.getElementById("editRoleProfile").value,
          target_roles: document.getElementById("editRoleTargets").value.trim(),
          target_city: document.getElementById("editRoleCity").value.trim(),
          target_salary: document.getElementById("editRoleSalary").value.trim(),
          role_keywords: document.getElementById("editRoleKeywords").value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean),
        },
      });
      document.getElementById("editRoleDialog").close();
      await refreshRoles();
      await refreshRouting();
      toast("角色已修改");
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnGenerateRoleKeywords").onclick = async () => {
    try { await generateRoleKeywords(); } catch (error) { alert(error.message); }
  };
  const openNotification = (item) => {
    if (!item) return;
    document.getElementById("notificationTitle").textContent = item.title || item.type;
    document.getElementById("notificationBody").textContent = `${item.body || ""}\n\n时间：${item.created_at || ""}\n状态：${item.status || ""}`;
    document.getElementById("notificationDialog").showModal();
  };
  document.getElementById("messageLog").addEventListener("click", (event) => {
    const row = event.target.closest("[data-notification]");
    if (!row) return;
    openNotification((state.notifications || []).find((entry) => String(entry.id) === String(row.dataset.notification)));
  });
  document.getElementById("notificationHistoryList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-notification]");
    if (!row) return;
    openNotification((state.historyNotifications || []).find((entry) => String(entry.id) === String(row.dataset.notification)));
  });
  document.getElementById("btnSearchNotifications").onclick = async () => {
    state.notificationPage = 1;
    try { await refreshNotificationHistory(); } catch (error) { alert(error.message); }
  };
  document.getElementById("notificationSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") document.getElementById("btnSearchNotifications").click();
  });
  document.getElementById("notificationPageSize").onchange = async () => {
    state.notificationPage = 1;
    try { await refreshNotificationHistory(); } catch (error) { alert(error.message); }
  };
  document.getElementById("btnNotificationPrev").onclick = async () => {
    if (state.notificationPage <= 1) return;
    state.notificationPage -= 1;
    try { await refreshNotificationHistory(); } catch (error) { alert(error.message); }
  };
  document.getElementById("btnNotificationNext").onclick = async () => {
    if (state.notificationPage >= state.notificationPages) return;
    state.notificationPage += 1;
    try { await refreshNotificationHistory(); } catch (error) { alert(error.message); }
  };
  document.getElementById("btnSaveGroup").onclick = async () => {
    try {
      await api("/api/feishu-groups", {
        method: "POST",
        body: {
          id: state.editingGroupId || undefined,
          name: document.getElementById("groupName").value.trim(),
          chatId: document.getElementById("groupChatId").value.trim(),
          webhook: document.getElementById("groupWebhook").value.trim(),
        },
      });
      state.editingGroupId = "";
      await refreshGroups();
      await refreshRouting();
      resetGroupForm();
      document.getElementById("groupDialog").close();
      toast("飞书群已保存，请在卡片上点“测试”确认连通");
    } catch (error) { alert(error.message); }
  };
  document.getElementById("groupCards").addEventListener("click", async (event) => {
    const testGroup = event.target.closest("button[data-test-group]");
    const edit = event.target.closest("button[data-edit-group]");
    const del = event.target.closest("button[data-delete-group]");
    try {
      if (testGroup) {
        try {
          const result = await api(`/api/feishu-groups/${testGroup.dataset.testGroup}/test`, { method: "POST", body: {} });
          toast(`群测试已发送${result.result?.mode ? `（${result.result.mode}）` : ""}`);
        } catch (error) {
          toast(`群测试失败：${error.message}`, true);
        }
        await refreshGroups();
        return;
      }
      if (edit) {
        const group = state.feishuGroups.find((item) => item.id === edit.dataset.editGroup);
        if (!group) return;
        state.editingGroupId = group.id;
        document.getElementById("groupDialogTitle").textContent = "重命名 / 修改群";
        document.getElementById("groupName").value = group.name;
        document.getElementById("groupChatId").value = group.chat_id;
        document.getElementById("groupWebhook").value = group.webhook || "";
        document.getElementById("groupDialog").showModal();
        return;
      }
      if (del) {
        const group = state.feishuGroups.find((item) => item.id === del.dataset.deleteGroup);
        if (!group) return;
        state.deleteGroupId = group.id;
        const roleNames = group.roles.map((item) => state.roles.find((role) => role.role_uuid === item.role_uuid)?.nickname || item.role_uuid.slice(0, 6));
        document.getElementById("deleteGroupInfo").textContent = `群名称：${group.name}\nChat ID：${group.chat_id}\n状态：${group.status}\n正在使用：${roleNames.length ? roleNames.join("、") : "无角色"}`;
        document.getElementById("deleteGroupDialog").showModal();
      }
    } catch (error) { alert(error.message); }
  });
  document.getElementById("btnConfirmDeleteGroup").onclick = async () => {
    if (!state.deleteGroupId) return;
    try {
      await api(`/api/feishu-groups/${state.deleteGroupId}`, { method: "DELETE" });
      state.deleteGroupId = "";
      document.getElementById("deleteGroupDialog").close();
      await refreshGroups();
      await refreshRouting();
      toast("群已删除");
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnCancelDeleteGroup").onclick = () => document.getElementById("deleteGroupDialog").close();
  document.getElementById("routeStageBody").addEventListener("change", async (event) => {
    if (event.target.id !== "routingDefaultGroup") return;
    try {
      await api("/api/feishu-groups/default", { method: "POST", body: { groupId: event.target.value } });
      await refreshGroups();
      await refreshRouting();
      toast("默认通知群已更新");
    } catch (error) { alert(error.message); }
  });
  document.getElementById("routeStageBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-route-role]");
    if (!button || !state.feishuGroups.length) {
      if (button && !state.feishuGroups.length) toast("请先添加飞书群", true);
      return;
    }
    state.routeGroupRole = button.dataset.routeRole;
    state.routeGroupStage = button.dataset.routeStage;
    document.getElementById("routeGroupInfo").textContent = `为 ${button.dataset.routeLabel} 选择通知群`;
    document.getElementById("routeGroupSelect").innerHTML = '<option value="">不发送</option>' + state.feishuGroups.map((group) => `<option value="${group.id}">${esc(group.name)}</option>`).join("");
    document.getElementById("routeGroupDialog").showModal();
  });
  document.getElementById("btnSaveRouteGroup").onclick = async () => {
    try {
      await api("/api/feishu-routing/stage", {
        method: "POST",
        body: { roleUuid: state.routeGroupRole, stage: state.routeGroupStage, groupId: document.getElementById("routeGroupSelect").value },
      });
      document.getElementById("routeGroupDialog").close();
      await refreshRouting();
      toast("角色通知群已更新");
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnCancelRouteGroup").onclick = () => document.getElementById("routeGroupDialog").close();

  document.getElementById("btnRefresh").onclick = refreshAll;
  document.getElementById("btnTick").onclick = doTick;
  document.getElementById("btnTick2").onclick = doTick;
  document.getElementById("btnPlan").onclick = async () => {
    try {
      const result = await api("/api/collection/plan", { method: "POST", body: { forceReason: "manual" } });
      showLog("dashboardLog", result);
      await refreshTasks();
    } catch (error) { showLog("dashboardLog", error.message); }
  };
  document.getElementById("btnLoginStatus").onclick = async () => {
    try {
      showLog("dashboardLog", await api("/api/login/status"));
      await refreshHealth();
    } catch (error) { showLog("dashboardLog", error.message); }
  };

  document.getElementById("channelCards").addEventListener("click", async (event) => {
    const check = event.target.closest("button[data-channel-check]");
    const open = event.target.closest("button[data-channel-open]");
    try {
      if (check) {
        const platform = check.dataset.channelCheck;
        try {
          const result = await api("/api/login/check", { method: "POST", body: { platform } });
          showLog("dashboardLog", result);
          toast(`${platform} 已登录`);
          await refreshHealth();
        } catch (error) {
          showLog("dashboardLog", error.message);
          toast(error.message, true);
        }
        return;
      }
      if (open) {
        const platform = open.dataset.channelOpen;
        const result = await api("/api/chrome/open", { method: "POST", body: { platform } });
        showLog("dashboardLog", `已打开 ${platform} 登录页：${result.url}（CDP 端口 ${result.port}${result.conflict ? "，9222 被占用已自动切换" : ""}）`);
        toast(`Chrome CDP：127.0.0.1:${result.port}`);
      }
    } catch (error) { showLog("dashboardLog", error.message); }
  });

  document.getElementById("resumeFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const content = await file.text();
      state.resumeContent = content;
      state.resumeFileName = file.name;
      document.getElementById("roleProfile").value = content;
      document.getElementById("resumeStatus").textContent = `已导入：${file.name}（${content.length} 字）`;
    } catch (error) {
      alert(`读取简历失败：${error.message}`);
    }
  });

  document.getElementById("btnGenerateKeywords").onclick = async () => {
    try {
      const result = await api("/api/keywords/generate", {
        method: "POST",
        body: {
          profile_md: document.getElementById("roleProfile").value.trim(),
          target_roles: document.getElementById("roleTargets").value.trim(),
          target_city: document.getElementById("roleCity").value.trim(),
          target_salary: document.getElementById("roleSalary").value.trim(),
        },
      });
      document.getElementById("roleKeywords").value = (result.keywords || []).join("、");
      toast(result.aiUsed ? "AI 已生成每日关键词" : "已用本地规则生成关键词");
    } catch (error) { alert(error.message); }
  };

  document.getElementById("btnCreateRole").onclick = async () => {
    try {
      const result = await api("/api/roles", {
        method: "POST",
        body: {
          nickname: document.getElementById("roleNickname").value.trim(),
          profile_md: document.getElementById("roleProfile").value.trim(),
          resume_md: state.resumeContent,
          resume_file_name: state.resumeFileName,
          target_roles: document.getElementById("roleTargets").value.trim(),
          target_city: document.getElementById("roleCity").value.trim(),
          target_salary: document.getElementById("roleSalary").value.trim(),
          role_keywords: document.getElementById("roleKeywords").value.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        },
      });
      if (result.similar?.length) {
        alert(`与已有角色相似：${result.similar.map((item) => `${item.role_number} ${item.nickname}（${Math.round(item.score * 100)}%）`).join("，")}`);
      }
      state.resumeContent = "";
      state.resumeFileName = "";
      for (const id of ["roleNickname", "roleProfile", "roleTargets", "roleCity", "roleSalary", "roleKeywords"]) {
        document.getElementById(id).value = "";
      }
      document.getElementById("resumeFile").value = "";
      document.getElementById("resumeStatus").textContent = "未选择简历；也可以直接粘贴到下方";
      await refreshRoles();
      await refreshRouting();
      toast("角色已创建");
    } catch (error) { alert(error.message); }
  };

  document.getElementById("btnConfirmRole").onclick = async () => {
    const channels = [];
    if (document.getElementById("confirmBoss").checked) channels.push("BOSS");
    if (document.getElementById("confirmLiepin").checked) channels.push("猎聘");
    if (!channels.length) {
      alert("至少选择一个渠道");
      return;
    }
    try {
      await api(`/api/roles/${state.confirmRoleId}/confirm`, {
        method: "POST",
        body: { channels },
      });
      document.getElementById("confirmDialog").close();
      await refreshRoles();
      await refreshJobs();
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnCancelConfirm").onclick = () => document.getElementById("confirmDialog").close();

  document.getElementById("roleList").addEventListener("click", async (event) => {
    const editButton = event.target.closest("button[data-edit-role]");
    if (editButton) {
      openEditRole(editButton.dataset.editRole);
      return;
    }
    const keywordButton = event.target.closest("button[data-keywords]");
    if (keywordButton) {
      try { await openKeywordDialog(keywordButton.dataset.keywords); } catch (error) { alert(error.message); }
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "confirm") {
      openConfirmDialog(id);
      return;
    }
    try {
      await api(`/api/roles/${id}/${action}`, { method: "POST", body: {} });
      await refreshRoles();
      await refreshJobs();
    } catch (error) { alert(error.message); }
  });

  document.getElementById("taskList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-task]");
    if (!button) return;
    try {
      await api(`/api/tasks/${button.dataset.id}/${button.dataset.task}`, { method: "POST", body: {} });
      await refreshTasks();
    } catch (error) { alert(error.message); }
  });

  document.getElementById("jobRoleSelect").onchange = () => {
    state.jobPage = 1;
    refreshJobs();
  };
  document.getElementById("btnJobSearch").onclick = () => {
    state.jobPage = 1;
    refreshJobs();
  };
  document.getElementById("btnRecheckJobs").onclick = async () => {
    const button = document.getElementById("btnRecheckJobs");
    const status = document.getElementById("jobRecheckStatus");
    if (state.recheckPolling) {
      try { await api("/api/jobs/recheck", { method: "POST", body: { action: "cancel" } }); } catch (error) { /* ignore */ }
      stopRecheckView();
      return;
    }
    if (!window.confirm("将检查最近 1 周以上未见、仍未关闭的岗位；从最久未见开始，确认不存在则关闭。继续？")) return;
    try {
      const result = await api("/api/jobs/recheck", { method: "POST", body: {} });
      if (!result.started) {
        if (result.reason === "already_running") {
          state.recheckPolling = true;
          button.textContent = "停止确认";
          pollRecheck();
          return;
        }
        status.textContent = result.reason === "other_task" ? "已有其他任务在执行，未启动历史岗位确认。" : "没有需要确认的历史岗位。";
        return;
      }
      state.recheckPolling = true;
      button.textContent = "停止确认";
      button.classList.add("danger");
      renderRecheckProgress(result.status);
      pollRecheck();
    } catch (error) {
      status.textContent = `确认失败：${error.message}`;
    }
  };

  document.getElementById("btnJobReset").onclick = () => {
    for (const id of ["jobSearch", "jobLocation", "jobSalaryMin", "jobSalaryMax", "jobDateFrom", "jobDateTo"]) {
      document.getElementById(id).value = "";
    }
    document.getElementById("jobSort").value = "score_desc";
    document.getElementById("jobPageSize").value = "20";
    state.jobPage = 1;
    state.jobPageSize = 20;
    refreshJobs();
  };
  document.getElementById("jobPageSize").onchange = () => {
    state.jobPageSize = Number(document.getElementById("jobPageSize").value || 20);
    state.jobPage = 1;
    refreshJobs();
  };
  document.getElementById("jobPager").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (button) {
      state.jobPage = Number(button.dataset.page || 1);
      refreshJobs();
      return;
    }
    if (event.target.id === "btnJobJump") {
      const value = Number(document.getElementById("jobJump").value || 1);
      state.jobPage = Math.max(1, Math.min(state.jobPages, value));
      refreshJobs();
    }
  });
  document.getElementById("btnExport").onclick = () => {
    const roleUuid = document.getElementById("jobRoleSelect").value;
    if (roleUuid) window.location.href = `/api/export/${roleUuid}`;
  };

  document.getElementById("btnShowLogs").onclick = async () => {
    try {
      const data = await api("/api/logs?limit=200");
      document.getElementById("localLogStats").textContent = `目录：${data.stats.dir} · 总量 ${Math.round(data.stats.totalBytes / 1024)} KB / 上限 ${Math.round(data.stats.maxTotalBytes / 1024)} KB`;
      document.getElementById("localLogs").textContent = data.logs.join("\n") || "暂无日志";
    } catch (error) { alert(error.message); }
  };

  document.getElementById("settingsForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/settings", {
        method: "POST",
        body: {
          collection_days: document.getElementById("setDays").value,
          collection_start: document.getElementById("setStart").value,
          collection_end: document.getElementById("setEnd").value,
          min_collection_runs: Number(document.getElementById("setMinRuns").value),
          min_interval_hours: Number(document.getElementById("setInterval").value),
          report_time: document.getElementById("setReportTime").value,
          idle_minutes: Number(document.getElementById("setIdle").value),
          cpu_max_percent: Number(document.getElementById("setCpu").value),
          battery_min_percent: Number(document.getElementById("setBattery").value),
          collect_at_ingest: document.getElementById("setCollectAtIngest").value === "true",
          feishu_webhook: document.getElementById("setFeishu").value.trim(),
        },
      });
      showLog("settingsLog", result.warnings?.length ? result.warnings.join("\n") : "已保存");
      await refreshSettings();
    } catch (error) { showLog("settingsLog", error.message); }
  };

  document.getElementById("btnSaveAi").onclick = async () => {
    try {
      await api("/api/ai/providers", {
        method: "POST",
        body: {
          name: document.getElementById("aiName").value.trim() || "未命名",
          type: document.getElementById("aiType").value,
          base_url: document.getElementById("aiBase").value.trim(),
          model: document.getElementById("aiModel").value.trim(),
          api_key: document.getElementById("aiKey").value,
          sort_order: Number(document.getElementById("aiOrder").value || 100),
        },
      });
      document.getElementById("aiKey").value = "";
      await refreshProviders();
    } catch (error) { alert(error.message); }
  };

  document.getElementById("aiList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-ai]");
    if (!button) return;
    if (button.dataset.ai !== "test") {
      try {
        await api(`/api/ai/providers/${button.dataset.id}/${button.dataset.ai}`, { method: "POST", body: {} });
        await refreshProviders();
      } catch (error) { alert(error.message); }
      return;
    }
    const dialog = document.getElementById("aiTestDialog");
    const title = document.getElementById("aiTestTitle");
    const body = document.getElementById("aiTestBody");
    title.textContent = "AI 测试中";
    body.textContent = "正在调用模型，请稍候…";
    dialog.showModal();
    button.disabled = true;
    try {
      const result = await api(`/api/ai/providers/${button.dataset.id}/test`, { method: "POST", body: {} });
      if (result.ok) {
        title.textContent = "AI 测试成功";
        body.textContent = `HTTP ${result.status || 200}，模型连接正常。`;
        setTimeout(() => {
          if (dialog.open) dialog.close();
        }, 1000);
      } else {
        title.textContent = "AI 测试失败";
        body.textContent = result.error || "供应商返回失败";
      }
      await refreshProviders();
    } catch (error) {
      title.textContent = "AI 测试失败";
      body.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("btnCloseAiTest").onclick = () => document.getElementById("aiTestDialog").close();

  document.getElementById("btnSaveMp").onclick = async () => {
    try {
      await api("/api/message-platform/config", {
        method: "POST",
        body: {
          appId: document.getElementById("mpAppId").value.trim(),
          appSecret: document.getElementById("mpAppSecret").value,
          chatId: document.getElementById("mpChatId").value.trim(),
          verifyToken: document.getElementById("mpVerifyToken").value,
          encryptKey: document.getElementById("mpEncryptKey").value,
        },
      });
      await refreshMessages();
      for (const id of ["mpAppSecret", "mpVerifyToken", "mpEncryptKey"]) document.getElementById(id).value = "";
      showLog("dashboardLog", "飞书应用配置已保存（.env）");
      toast("飞书应用配置已保存");
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnStartMp").onclick = async () => {
    try {
      await api("/api/message-platform/start", { method: "POST", body: {} });
      await refreshMessages();
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnStopMp").onclick = async () => {
    try {
      await api("/api/message-platform/stop", { method: "POST", body: {} });
      await refreshMessages();
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnSaveWebhook").onclick = async () => {
    try {
      const result = await api("/api/settings", {
        method: "POST",
        body: { feishu_webhook: document.getElementById("msgWebhook").value.trim() },
      });
      showLog("dashboardLog", result.warnings?.length ? result.warnings.join("\n") : "飞书 webhook 已保存");
      await refreshSettings();
      await refreshMessages();
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnTestWebhook").onclick = async () => {
    try {
      const result = await api("/api/messages/test", { method: "POST", body: {} });
      showLog("dashboardLog", result);
      await refreshMessages();
    } catch (error) { alert(error.message); }
  };

  document.getElementById("btnBuildReport").onclick = async () => {
    const roleUuid = document.getElementById("reportRoleSelect").value;
    if (!roleUuid) return;
    try {
      await api("/api/reports/build", { method: "POST", body: { roleUuid } });
      await refreshReports();
    } catch (error) { alert(error.message); }
  };

  document.getElementById("reportList").addEventListener("click", async (event) => {
    const groupsButton = event.target.closest("button[data-report-groups]");
    if (groupsButton) {
      try {
        const result = await api(`/api/reports/${groupsButton.dataset.reportGroups}/send-groups`, { method: "POST", body: {} });
        showLog("dashboardLog", result);
        alert(result.delivered ? `已发送到 ${result.delivered} 个群` : "没有匹配的群，已记录本地通知");
      } catch (error) { alert(error.message); }
      return;
    }
    const button = event.target.closest("button[data-report]");
    if (!button) return;
    const report = state.reports.find((item) => String(item.id) === String(button.dataset.report));
    if (report) alert(report.content);
  });
}

async function doTick() {
  try {
    const result = await api("/api/tasks/tick", { method: "POST", body: { idleAllowed: true, forceReason: "manual" } });
    showLog("dashboardLog", result);
    await refreshTasks();
    await refreshJobs();
  } catch (error) { showLog("dashboardLog", error.message); }
}

function renderRecheckProgress(status) {
  const text = document.getElementById("jobRecheckStatus");
  if (!text || !status) return;
  if (status.running) {
    text.textContent = `待执行 ${status.pending ?? status.total ?? "-"} · 已完成 ${status.completed ?? 0}/${status.total ?? "-"} · ${status.percent ?? 0}% · 已关闭 ${status.closed ?? 0}`;
  } else if (status.finished) {
    text.textContent = `完成：检查 ${status.completed ?? 0} 个，关闭 ${status.closed ?? 0} 个，无法确认 ${status.skipped ?? 0} 个。`;
  }
}

function stopRecheckView() {
  clearTimeout(state.recheckTimer);
  state.recheckPolling = false;
  const status = document.getElementById("jobRecheckStatus");
  if (status) status.textContent = "";
  const button = document.getElementById("btnRecheckJobs");
  if (button) {
    button.textContent = "历史岗位确认";
    button.classList.remove("danger");
  }
}

async function pollRecheck() {
  if (!state.recheckPolling) return;
  try {
    const result = await api("/api/jobs/recheck/status");
    const status = result.status || {};
    if (status.running) {
      renderRecheckProgress(status);
      state.recheckTimer = setTimeout(pollRecheck, 1200);
      return;
    }
    if (status.canceled || status.error) {
      stopRecheckView();
      if (status.error) alert(`历史岗位确认失败：${status.error}`);
      return;
    }
    if (status.finished) {
      renderRecheckProgress(status);
      toast("历史岗位确认完成");
      state.recheckPolling = false;
      const button = document.getElementById("btnRecheckJobs");
      if (button) { button.textContent = "历史岗位确认"; button.classList.remove("danger"); }
      await refreshJobs();
      state.recheckTimer = setTimeout(() => {
        if (!state.recheckPolling) {
          const text = document.getElementById("jobRecheckStatus");
          if (text) text.textContent = "";
        }
      }, 5000);
      return;
    }
    stopRecheckView();
  } catch (error) {
    stopRecheckView();
    const text = document.getElementById("jobRecheckStatus");
    if (text) text.textContent = `状态读取失败：${error.message}`;
  }
}

function setupTooltips() {
  const tooltip = document.getElementById("customTooltip");
  if (!tooltip) return;
  let timer = null;
  let active = null;
  const hide = () => {
    clearTimeout(timer);
    active = null;
    tooltip.hidden = true;
  };
  const show = (target) => {
    const text = target.dataset.tooltip;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const gap = 8;
    let left = rect.left;
    let top = rect.bottom + gap;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    if (top + height > window.innerHeight - 12) top = rect.top - height - gap;
    tooltip.style.left = `${Math.max(12, left)}px`;
    tooltip.style.top = `${Math.max(12, top)}px`;
  };
  document.querySelectorAll("[data-tooltip]").forEach((target) => {
    target.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      active = target;
      timer = setTimeout(() => {
        if (active === target) show(target);
      }, 500);
    });
    target.addEventListener("mouseleave", hide);
    target.addEventListener("focus", () => {
      clearTimeout(timer);
      timer = setTimeout(() => show(target), 500);
    });
    target.addEventListener("blur", hide);
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}

bind();
setupTooltips();
refreshAll().then(() => refreshRouting()).catch((error) => {
  const table = document.getElementById("routeStageBody");
  if (table) table.innerHTML = `<tr><td colspan="4" class="empty">角色通知群加载失败：${esc(error.message)}</td></tr>`;
});
refreshRouting().catch((error) => {
  const table = document.getElementById("routeStageBody");
  if (table) table.innerHTML = `<tr><td colspan="4" class="empty">角色通知群加载失败：${esc(error.message)}</td></tr>`;
});
refreshNotificationHistory().catch((error) => {
  const list = document.getElementById("notificationHistoryList");
  if (list) list.innerHTML = `<div class="empty">历史通知加载失败：${esc(error.message)}</div>`;
});
setInterval(refreshHealth, 15000);
setInterval(() => refreshTasks().catch(() => {}), 4000);
