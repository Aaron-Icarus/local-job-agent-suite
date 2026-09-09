const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..", "..");
const defaultConfigPath = path.join(rootDir, "config", "platform_channels.json");
const knownPlatforms = ["boss", "liepin"];

function configuredChannelPath() {
  const value = process.env.PLATFORM_CHANNEL_CONFIG_PATH || defaultConfigPath;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function validateChannelConfig(config) {
  const issues = [];
  for (const name of knownPlatforms) {
    const item = config?.platforms?.[name];
    if (!item) {
      issues.push(`缺少平台配置：${name}。`);
      continue;
    }
    if (typeof item.enabled !== "boolean") issues.push(`${name}.enabled 必须是 true 或 false。`);
    if (typeof item.detail_capture !== "boolean") issues.push(`${name}.detail_capture 必须是 true 或 false。`);
  }
  return issues;
}

function envBoolValue(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return null;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function loadChannelConfig(filePath = configuredChannelPath()) {
  let config;
  if (fs.existsSync(filePath)) {
    config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } else {
    config = {
      version: 1,
      platforms: {
        boss: { label: "BOSS直聘", enabled: envBoolValue("ENABLE_BOSS") ?? false, detail_capture: envBoolValue("BOSS_UI_DETAIL_CAPTURE") ?? true },
        liepin: { label: "猎聘", enabled: envBoolValue("ENABLE_LIEPIN") ?? false, detail_capture: envBoolValue("LIEPIN_ENABLE_DETAIL") ?? false },
      },
    };
  }
  if (/^(1|true|yes)$/i.test(process.env.PLATFORM_ENV_OVERRIDE || "")) {
    for (const name of knownPlatforms) {
      const enabled = envBoolValue(`ENABLE_${name.toUpperCase()}`);
      if (enabled !== null) config.platforms[name].enabled = enabled;
    }
    const bossDetail = envBoolValue("BOSS_UI_DETAIL_CAPTURE");
    const liepinDetail = envBoolValue("LIEPIN_ENABLE_DETAIL");
    if (bossDetail !== null) config.platforms.boss.detail_capture = bossDetail;
    if (liepinDetail !== null) config.platforms.liepin.detail_capture = liepinDetail;
  }
  const issues = validateChannelConfig(config);
  if (issues.length) throw new Error(`Invalid platform channel config:\n- ${issues.join("\n- ")}`);
  return { config, filePath };
}

function platformEnabled(config, name) {
  return config?.platforms?.[String(name).toLowerCase()]?.enabled === true;
}

function platformRuntimeEnv(config, name, baseEnv = process.env) {
  const key = String(name).toLowerCase();
  const item = config.platforms[key];
  const env = { ...baseEnv, [`ENABLE_${key.toUpperCase()}`]: item.enabled ? "true" : "false" };
  if (key === "boss") env.BOSS_UI_DETAIL_CAPTURE = item.detail_capture ? "true" : "false";
  if (key === "liepin") env.LIEPIN_ENABLE_DETAIL = item.detail_capture ? "true" : "false";
  return env;
}

function saveChannelConfig(config, filePath = configuredChannelPath()) {
  const issues = validateChannelConfig(config);
  if (issues.length) throw new Error(issues.join(" "));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return filePath;
}

module.exports = {
  knownPlatforms,
  configuredChannelPath,
  validateChannelConfig,
  loadChannelConfig,
  saveChannelConfig,
  platformEnabled,
  platformRuntimeEnv,
};
