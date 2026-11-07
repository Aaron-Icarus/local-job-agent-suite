const { execFile } = require("child_process");

const CACHE_MS = 15000;
let cache = { at: 0, value: null };

function exec(command, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function readIdleSeconds() {
  if (process.platform === "win32") {
    const code = "using System;using System.Runtime.InteropServices;public class IdleTime{[StructLayout(LayoutKind.Sequential)]public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}[DllImport(\"user32.dll\")]static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);[DllImport(\"kernel32.dll\")]static extern uint GetTickCount();public static uint IdleSeconds(){LASTINPUTINFO li=new LASTINPUTINFO();li.cbSize=(uint)Marshal.SizeOf(li);GetLastInputInfo(ref li);return ((uint)GetTickCount()-li.dwTime)/1000;}}";
    const script = `Add-Type -TypeDefinition '${code}'; [IdleTime]::IdleSeconds()`;
    const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 6000);
    if (result.error) return { available: false, error: result.error.message };
    const value = Number(result.stdout.trim().split(/\s+/).pop());
    return Number.isFinite(value) ? { available: true, seconds: value } : { available: false, error: result.stdout.trim() };
  }
  if (process.platform === "darwin") {
    const result = await exec("ioreg", ["-c", "IOHIDSystem", "-d", "1"]);
    if (result.error) return { available: false, error: result.error.message };
    const match = result.stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    const value = match ? Number(match[1]) / 1e9 : NaN;
    return Number.isFinite(value) ? { available: true, seconds: value } : { available: false, error: "无法读取 HIDIdleTime" };
  }
  return { available: false, error: "当前系统未实现空闲检测" };
}

async function getIdleStatus(options = {}) {
  const threshold = Math.max(0, Number(options.thresholdSeconds || 120));
  if (cache.value && Date.now() - cache.at < CACHE_MS) {
    return {
      ...cache.value,
      threshold,
      active: cache.value.available ? Number(cache.value.seconds) < threshold : false,
    };
  }
  const raw = await readIdleSeconds();
  const value = {
    platform: process.platform,
    available: Boolean(raw.available),
    seconds: raw.available ? Number(raw.seconds) : null,
    active: raw.available ? Number(raw.seconds) < threshold : false,
    error: raw.error || "",
  };
  cache = { at: Date.now(), value };
  return { ...value, threshold };
}

module.exports = { getIdleStatus };
