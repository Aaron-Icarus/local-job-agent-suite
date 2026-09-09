const fs = require("fs");
const path = require("path");
const { loadEnv, envNumber } = require("../core/load_env");
const { shanghaiDateKey, shanghaiDateTime } = require("../core/time_utils");
const {
  defaultStorePath,
  loadJobStore,
  saveJobStore,
  jobStoreKey,
  platformKey,
  upsertEvaluatedFiles,
  refreshMissingOpenJobs,
  writeStoreSnapshot,
} = require("./job_store");

loadEnv();

const rootDir = path.resolve(__dirname, "..", "..");
const outputsDir = path.join(rootDir, "outputs");
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") && !args[0].toLowerCase().endsWith(".json") ? args.shift() : "upsert";

function valueArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function flag(name) {
  return args.includes(`--${name}`);
}

function latestFiles(patterns) {
  if (!fs.existsSync(outputsDir)) return [];
  const files = fs.readdirSync(outputsDir).map((name) => ({
    name,
    full: path.join(outputsDir, name),
    mtime: fs.statSync(path.join(outputsDir, name)).mtimeMs,
  }));
  return patterns.map((pattern) => files.filter((file) => pattern.test(file.name)).sort((a, b) => b.mtime - a.mtime)[0]?.full).filter(Boolean);
}

function jsonInputs() {
  const explicit = args.filter((arg) => arg.toLowerCase().endsWith(".json") && !arg.startsWith("--"));
  if (explicit.length) return explicit;
  return latestFiles([/^boss_stage3_fit_evaluated_.*\.json$/, /^liepin_stage3_fit_evaluated_.*\.json$/]);
}

function writeSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
}

function assertInputDates(inputPaths, dateKey) {
  if (process.env.ALLOW_STALE_INPUT === "true") return;
  for (const inputPath of inputPaths) {
    const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const dates = [...new Set((payload.records || []).map((row) => row.evaluation_date).filter(Boolean))];
    if (payload.evaluation_date) dates.push(payload.evaluation_date);
    const distinct = [...new Set(dates)];
    if (!distinct.length || distinct.some((value) => value !== dateKey)) {
      throw new Error(`Input date does not match --date=${dateKey}: ${inputPath}. Set ALLOW_STALE_INPUT=true only for an intentional manual replay.`);
    }
  }
}

function main() {
  const dateKey = valueArg("date", process.env.EVALUATION_DATE || shanghaiDateKey());
  const now = shanghaiDateTime();
  const storePath = valueArg("store", defaultStorePath());
  const store = loadJobStore(storePath);
  const inputPaths = jsonInputs();
  if ((command === "upsert" || command === "refresh") && !inputPaths.length) {
    throw new Error("No input JSON files. Pass evaluated/tracked JSON files or keep latest outputs available.");
  }
  if (command === "upsert" || command === "refresh") assertInputDates(inputPaths, dateKey);

  if (command === "upsert") {
    const result = upsertEvaluatedFiles(store, inputPaths, { dateKey, now, outputsDir });
    let snapshot = null;
    if (!flag("no-snapshot")) snapshot = writeStoreSnapshot(store, { dateKey, outputsDir });
    if (!flag("dry-run")) saveJobStore(store, storePath);
    writeSummary({
      command,
      storePath,
      dateKey,
      dryRun: flag("dry-run"),
      inputPaths,
      trackedFiles: result.trackedFiles,
      currentCount: result.currentKeys.length,
      newCount: result.newKeys.length,
      changedCount: result.changedKeys.length,
      snapshot,
    });
    return;
  }

  if (command === "refresh") {
    const currentKeys = [];
    const detectedPlatforms = new Set();
    const requestedPlatformValue = valueArg("platform", "");
    const requestedPlatform = requestedPlatformValue ? platformKey({ platform: requestedPlatformValue }) : "";
    const inputPlatforms = new Set();
    if (requestedPlatform) detectedPlatforms.add(requestedPlatform);
    for (const inputPath of inputPaths) {
      const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
      if (payload.platform) inputPlatforms.add(platformKey({ platform: payload.platform }));
      for (const row of payload.records || []) {
        const rowPlatform = platformKey(row);
        inputPlatforms.add(rowPlatform);
        if (requestedPlatform && rowPlatform !== requestedPlatform) continue;
        currentKeys.push(jobStoreKey(row));
        if (!requestedPlatform) detectedPlatforms.add(rowPlatform);
      }
    }
    if (requestedPlatform && inputPlatforms.size && !inputPlatforms.has(requestedPlatform)) {
      throw new Error(`Refresh input does not contain requested platform ${requestedPlatform}. Detected: ${[...inputPlatforms].join(", ")}.`);
    }
    if (!detectedPlatforms.size) throw new Error("Cannot determine platform for refresh. Pass --platform=boss or --platform=liepin.");
    const refresh = refreshMissingOpenJobs(store, [...new Set(currentKeys)], {
      dateKey,
      now,
      closeAfterDays: envNumber("JOB_CLOSE_AFTER_MISSING_DAYS", 7),
      platforms: [...detectedPlatforms],
    });
    const snapshot = writeStoreSnapshot(store, { dateKey, outputsDir });
    if (!flag("dry-run")) saveJobStore(store, storePath);
    writeSummary({
      command,
      storePath,
      dateKey,
      dryRun: flag("dry-run"),
      inputPaths,
      currentCount: new Set(currentKeys).size,
      unknownCount: refresh.unknown.length,
      closedCount: refresh.closed.length,
      changedCount: refresh.changed.length,
      closeAfterDays: refresh.closeAfterDays,
      platforms: refresh.platforms,
      snapshot,
    });
    return;
  }

  if (command === "snapshot") {
    const snapshot = writeStoreSnapshot(store, { dateKey, outputsDir });
    writeSummary({ command, storePath, dateKey, snapshot });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main();
