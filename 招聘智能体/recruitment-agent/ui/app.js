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
          ${["pending_start", "paused"].includes(role.status) ? `<button class="small" data-action="start" data-id="${role.role_uuid}">启动</button>` : ""}
          ${role.status === "running" ? `<button class="small ghost" data-action="pause" data-id="${role.role_uuid}">暂停</button>` : ""}
          <button class="small ghost" data-action="copy" data-id="${role.role_uuid}">复制</button>
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
  const summary = document.getElementById("taskSummary");
  const running = state.tasks.filter((task) => task.status === "running").length;
  const queued = state.tasks.filter((task) => ["queued", "retrying"].includes(task.status)).length;
  summary.innerHTML = `
    <div class="card"><div class="num">${running}</div><div class="label">运行中</div></div>
    <div class="card"><div class="num">${queued}</div><div class="label">排队/重试</div></div>
    <div class="card"><div class="num">${state.events.length}</div><div class="label">采集事件</div></div>
    <div class="card"><div class="num">${data.runningCollection ? "是" : "否"}</div><div class="label">采集运行中</div></div>
  `;
  const list = document.getElementById("taskList");
  list.innerHTML = state.tasks.length ? state.tasks.map((task) => `
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
    </div>`).join("") : '<div class="empty">暂无任务</div>';
  const events = document.getElementById("eventList");
  events.innerHTML = state.events.length ? state.events.map((event) => `
    <div class="row">
      <div>
        <strong>事件 #${event.id}</strong> ${tag(event.status, event.status === "success" ? "ok" : event.status === "failed" ? "bad" : "warn")}
        <div class="meta">${esc(event.event_date)} · 子任务成功 ${event.success_subtasks} / 失败 ${event.failed_subtasks} · ${esc(event.force_reason || "常规")}</div>
      </div>
    </div>`).join("") : '<div class="empty">暂无采集事件</div>';
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
  const checks = document.getElementById("groupRoleChecks");
  if (checks) {
    checks.innerHTML = state.roles.map((role) => `<label><input type="checkbox" data-group-role="${role.role_uuid}"> ${esc(role.role_number)} ${esc(role.nickname)} ${role.status === "running" ? "（运行中）" : ""}</label>`).join("");
  }
  const replySelect = document.getElementById("groupReplyRole");
  if (replySelect) {
    const current = replySelect.value;
    replySelect.innerHTML = state.roles.map((role) => `<option value="${role.role_uuid}">${esc(role.role_number)} ${esc(role.nickname)}</option>`).join("");
    if (current) replySelect.value = current;
  }
  const list = document.getElementById("groupList");
  if (list) {
    list.innerHTML = state.feishuGroups.length ? state.feishuGroups.map((group) => {
      const roles = group.roles.map((item) => state.roles.find((role) => role.role_uuid === item.role_uuid)?.nickname || item.role_uuid.slice(0, 6)).join("、");
      const nodes = [
        group.roles.some((item) => item.notify_login) ? "登录" : "",
        group.roles.some((item) => item.notify_error) ? "异常" : "",
        group.roles.some((item) => item.notify_daily) ? "日报" : "",
      ].filter(Boolean).join("/");
      return `<div class="row">
        <div>
          <strong>${esc(group.name)}</strong> ${group.is_default ? tag("默认", "ok") : ""} ${tag(group.enabled ? "启用" : "关闭", group.enabled ? "ok" : "")}
          <div class="meta">Chat ID: ${esc(group.chat_id)} · 角色：${esc(roles || "未选")} · 节点：${esc(nodes || "无")}${group.webhook ? " · webhook" : ""}</div>
        </div>
        <div class="actions">
          ${group.is_default ? "" : `<button class="small ghost" data-default-group="${group.id}">设为默认</button>`}
          <button class="small ghost" data-test-group="${group.id}">测试</button>
          <button class="small ghost" data-edit-group="${group.id}">修改</button>
          <button class="small danger" data-delete-group="${group.id}">删除</button>
        </div>
      </div>`;
    }).join("") : '<div class="empty">还没有配置飞书群。</div>';
  }
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
    await refreshGroups();
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
        },
      });
      await refreshRoles();
      toast(`角色 ${result.role.role_number} 已创建，请确认渠道`);
    } catch (error) { alert(error.message); }
  });

  document.getElementById("btnFillGroup").onclick = () => {
    document.querySelectorAll('[data-group-role]').forEach((input) => {
      const role = state.roles.find((item) => item.role_uuid === input.dataset.groupRole);
      input.checked = Boolean(role && role.status === "running");
    });
    for (const id of ["groupNotifyLogin", "groupNotifyError", "groupNotifyDaily"]) {
      document.getElementById(id).checked = true;
    }
  };
  document.getElementById("btnResetGroup").onclick = () => {
    state.editingGroupId = "";
    for (const id of ["groupName", "groupChatId", "groupWebhook"]) document.getElementById(id).value = "";
    document.querySelectorAll('[data-group-role]').forEach((input) => { input.checked = false; });
    for (const id of ["groupNotifyLogin", "groupNotifyError", "groupNotifyDaily"]) document.getElementById(id).checked = true;
  };
  document.getElementById("btnSyncGroups").onclick = async () => {
    try {
      const result = await api("/api/message-platform/sync-groups", { method: "POST", body: {} });
      await refreshMessages();
      toast(`已同步 ${result.groups} 个群到消息平台，重启服务生效`);
    } catch (error) { alert(error.message); }
  };
  document.getElementById("btnGroupConfig").onclick = () => {
    state.editingGroupId = "";
    for (const id of ["groupName", "groupChatId", "groupWebhook"]) document.getElementById(id).value = "";
    document.querySelectorAll('[data-group-role]').forEach((input) => { input.checked = false; });
    document.getElementById("groupDialog").showModal();
  };
  document.getElementById("btnCloseGroupDialog").onclick = () => document.getElementById("groupDialog").close();
  document.getElementById("btnGroupHelp").onclick = () => document.getElementById("helpDialog").showModal();
  document.getElementById("btnCloseHelp").onclick = () => document.getElementById("helpDialog").close();
  document.getElementById("btnCloseNotification").onclick = () => document.getElementById("notificationDialog").close();
  document.getElementById("messageLog").addEventListener("click", (event) => {
    const row = event.target.closest("[data-notification]");
    if (!row) return;
    const item = (state.notifications || []).find((entry) => String(entry.id) === String(row.dataset.notification));
    if (!item) return;
    document.getElementById("notificationTitle").textContent = item.title || item.type;
    document.getElementById("notificationBody").textContent = `${item.body || ""}\n\n时间：${item.created_at || ""}\n状态：${item.status || ""}`;
    document.getElementById("notificationDialog").showModal();
  });
  document.getElementById("btnSaveGroup").onclick = async () => {
    const roles = [...document.querySelectorAll('[data-group-role]:checked')].map((input) => ({
      role_uuid: input.dataset.groupRole,
      notify_login: document.getElementById("groupNotifyLogin").checked,
      notify_error: document.getElementById("groupNotifyError").checked,
      notify_daily: document.getElementById("groupNotifyDaily").checked,
    }));
    try {
      await api("/api/feishu-groups", {
        method: "POST",
        body: {
          id: state.editingGroupId || undefined,
          name: document.getElementById("groupName").value.trim(),
          chatId: document.getElementById("groupChatId").value.trim(),
          webhook: document.getElementById("groupWebhook").value.trim(),
          replyRoleUuid: document.getElementById("groupReplyRole").value,
          roles,
        },
      });
      state.editingGroupId = "";
      await refreshGroups();
      document.getElementById("groupDialog").close();
      toast("飞书群配置已保存");
    } catch (error) { alert(error.message); }
  };
  document.getElementById("groupList").addEventListener("click", async (event) => {
    const edit = event.target.closest("button[data-edit-group]");
    const del = event.target.closest("button[data-delete-group]");
    const setDefault = event.target.closest("button[data-default-group]");
    const testGroup = event.target.closest("button[data-test-group]");
    try {
      if (testGroup) {
        const result = await api(`/api/feishu-groups/${testGroup.dataset.testGroup}/test`, { method: "POST", body: {} });
        toast(`群测试已发送${result.result?.mode ? `（${result.result.mode}）` : ""}`);
      }
      if (setDefault) {
        const group = state.feishuGroups.find((item) => item.id === setDefault.dataset.defaultGroup);
        if (!group) return;
        await api("/api/feishu-groups", {
          method: "POST",
          body: {
            id: group.id,
            name: group.name,
            chatId: group.chat_id,
            webhook: group.webhook || "",
            isDefault: true,
            replyRoleUuid: group.reply_role_uuid || "",
            roles: group.roles,
          },
        });
        await refreshGroups();
        toast(`已将「${group.name}」设为默认通知群`);
      }
      if (edit) {
        const group = state.feishuGroups.find((item) => item.id === edit.dataset.editGroup);
        if (!group) return;
        state.editingGroupId = group.id;
        document.getElementById("groupName").value = group.name;
        document.getElementById("groupChatId").value = group.chat_id;
        document.getElementById("groupWebhook").value = group.webhook || "";
        if (group.reply_role_uuid) document.getElementById("groupReplyRole").value = group.reply_role_uuid;
        document.querySelectorAll('[data-group-role]').forEach((input) => {
          const match = group.roles.find((item) => item.role_uuid === input.dataset.groupRole);
          input.checked = Boolean(match);
        });
        const first = group.roles[0];
        document.getElementById("groupNotifyLogin").checked = first ? first.notify_login : true;
        document.getElementById("groupNotifyError").checked = first ? first.notify_error : true;
        document.getElementById("groupNotifyDaily").checked = first ? first.notify_daily : true;
        document.getElementById("groupDialog").showModal();
      }
      if (del) {
        await api(`/api/feishu-groups/${del.dataset.deleteGroup}`, { method: "DELETE" });
        await refreshGroups();
      }
    } catch (error) { alert(error.message); }
  });

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
        const result = await api("/api/login/check", { method: "POST", body: { platform } });
        showLog("dashboardLog", result);
        await refreshHealth();
      }
      if (open) {
        const platform = open.dataset.channelOpen;
        const result = await api("/api/chrome/open", { method: "POST", body: { platform } });
        showLog("dashboardLog", `已打开 ${platform} 登录页：${result.url}`);
        toast(`已打开 ${platform} 登录页`);
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
      document.getElementById("roleKeywords").value = (result.keywords || []).join(", ");
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
      document.getElementById("resumeStatus").textContent = "未选择简历；也可以直接粘贴到下方";
      await refreshRoles();
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
    try {
      await api(`/api/ai/providers/${button.dataset.id}/${button.dataset.ai}`, { method: "POST", body: {} });
      await refreshProviders();
    } catch (error) { alert(error.message); }
  });

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
      showLog("dashboardLog", "飞书应用配置已保存（.env）");
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
    const result = await api("/api/tasks/tick", { method: "POST", body: { idleAllowed: true } });
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
refreshAll();
setInterval(refreshHealth, 15000);
