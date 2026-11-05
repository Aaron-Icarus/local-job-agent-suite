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
  for (const id of ["jobRoleSelect", "reportRoleSelect"]) {
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
  const data = await api(`/api/jobs?role=${encodeURIComponent(roleUuid)}&limit=100`);
  state.jobs = data.jobs || [];
  const list = document.getElementById("jobList");
  list.innerHTML = state.jobs.length ? state.jobs.map((job) => `
    <div class="row">
      <div>
        <strong>${esc(job.job_display_id)} ${esc(job.company || "")} · ${esc(job.title || "")}</strong>
        ${tag(job.job_status || "open", job.job_status === "closed" ? "bad" : "ok")}
        ${job.duplicate_status === "duplicate" ? tag("重复", "bad") : ""}
        <div class="meta">${esc(job.salary_text || "-")} · ${esc(job.city || "-")} · 采集 ${esc(job.first_seen_date || "-")} ~ ${esc(job.last_seen_date || "-")} · 评分 ${job.score ?? "-"} ${esc(job.tier || "")}</div>
      </div>
      <div class="actions">
        ${job.job_url ? `<a class="small" href="${esc(job.job_url)}" target="_blank" rel="noreferrer">打开岗位</a>` : ""}
      </div>
    </div>`).join("") : '<div class="empty">该角色暂无岗位。</div>';
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
      <div class="actions"><button class="small ghost" data-report="${report.id}">查看</button></div>
    </div>`).join("") : '<div class="empty">还没有日报。</div>';
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
        showLog("dashboardLog", `已打开 ${platform} 登录页`);
        void result;
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

  document.getElementById("jobRoleSelect").onchange = refreshJobs;
  document.getElementById("btnExport").onclick = () => {
    const roleUuid = document.getElementById("jobRoleSelect").value;
    if (roleUuid) window.location.href = `/api/export/${roleUuid}`;
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

  document.getElementById("btnBuildReport").onclick = async () => {
    const roleUuid = document.getElementById("reportRoleSelect").value;
    if (!roleUuid) return;
    try {
      await api("/api/reports/build", { method: "POST", body: { roleUuid } });
      await refreshReports();
    } catch (error) { alert(error.message); }
  };

  document.getElementById("reportList").addEventListener("click", (event) => {
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

bind();
refreshAll();
setInterval(refreshHealth, 15000);
