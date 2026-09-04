const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../core/load_env");
const { validatePreflight, errorText, configuredEnvPath } = require("../core/preflight");
const { sendRecruitmentNotification } = require("../push/outbound_sender");

const rootDir = path.resolve(__dirname, "..", "..");

function appendLog(event) {
  const filePath = path.join(rootDir, "logs", "preflight.log");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

async function main() {
  loadEnv(configuredEnvPath());
  const result = validatePreflight();
  if (result.ok) {
    console.log(JSON.stringify({ type: "preflight", ok: true }));
    return;
  }
  const text = errorText(result);
  appendLog({ type: "preflight_failed", issues: result.issues, env_path: result.envPath });
  try {
    const alert = await sendRecruitmentNotification(text, { topic: "recruitment_preflight_alert" });
    appendLog({ type: "preflight_alert", delivered: Boolean(alert?.status >= 200 && alert?.status < 300), result: alert });
  } catch (error) {
    appendLog({ type: "preflight_alert_error", error: error.message });
  }
  console.error(JSON.stringify({ type: "preflight_failed", message: "启动前配置检查未通过", issues: result.issues }));
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ type: "preflight_error", message: error.message }));
  process.exitCode = 2;
});
