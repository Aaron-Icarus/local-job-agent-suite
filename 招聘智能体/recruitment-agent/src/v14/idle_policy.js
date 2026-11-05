function evaluateIdle(input = {}) {
  const settings = input.settings || {};
  const idleSeconds = Number(input.idleSeconds || 0);
  const cpuPercent = Number(input.cpuPercent == null ? 0 : input.cpuPercent);
  const batteryPercent = Number(input.batteryPercent == null ? 100 : input.batteryPercent);
  const requiredIdleSeconds = Number(settings.idle_minutes || 5) * 60;
  const cpuMax = Number(settings.cpu_max_percent || 30);
  const batteryMin = Number(settings.battery_min_percent || 30);
  const idleOk = idleSeconds >= requiredIdleSeconds;
  const cpuOk = !Number.isFinite(cpuPercent) || cpuPercent < cpuMax;
  const batteryOk = !Number.isFinite(batteryPercent) || batteryPercent > batteryMin;
  return {
    allowed: idleOk && cpuOk && batteryOk,
    idleOk,
    cpuOk,
    batteryOk,
    idleSeconds,
    requiredIdleSeconds,
    cpuPercent,
    cpuMax,
    batteryPercent,
    batteryMin,
    hardPolicy: Boolean(settings.idle_hard_policy),
    reason: idleOk
      ? cpuOk
        ? batteryOk
          ? "idle_ok"
          : "battery_low"
        : "cpu_high"
      : "not_idle_enough",
  };
}

module.exports = { evaluateIdle };
