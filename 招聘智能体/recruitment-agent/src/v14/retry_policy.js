function canRetrySubtask(input = {}) {
  const attempts = Number(input.attempts || 0);
  const maxAttempts = Number(input.maxAttempts || 3);
  const windowAttempts = Number(input.windowAttempts || 0);
  const maxWindowAttempts = Number(input.maxWindowAttempts || 3);
  return {
    allowed: attempts < maxAttempts && windowAttempts < maxWindowAttempts,
    reason: attempts >= maxAttempts
      ? "max_attempts"
      : windowAttempts >= maxWindowAttempts
        ? "max_window_attempts"
        : "retry_ok",
  };
}

function retryDelayMs(attempt = 0) {
  // 子任务新标签页重试：首次 1 分钟，之后仍按 1 分钟；全局卡住 5 分钟只通知。
  return Math.max(1, Number(attempt || 0)) * 60000;
}

function stuckLevel(input = {}) {
  const lastHeartbeatAt = input.lastHeartbeatAt ? new Date(input.lastHeartbeatAt).getTime() : 0;
  const now = input.now ? new Date(input.now).getTime() : Date.now();
  const elapsedMs = lastHeartbeatAt ? now - lastHeartbeatAt : 0;
  if (!lastHeartbeatAt) return { stuck: false, elapsedMs: 0, level: "unknown" };
  if (elapsedMs >= 5 * 60000) return { stuck: true, elapsedMs, level: "global_stuck" };
  if (elapsedMs >= 60000) return { stuck: true, elapsedMs, level: "subtask_retry" };
  return { stuck: false, elapsedMs, level: "ok" };
}

module.exports = { canRetrySubtask, retryDelayMs, stuckLevel };
