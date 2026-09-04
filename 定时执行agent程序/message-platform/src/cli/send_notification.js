const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../core/config_loader");
const { sendActiveNotification } = require("../channels/outbound_gateway");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const rootDir = path.resolve(__dirname, "..", "..");
  loadConfig(rootDir);
  const inputPath = argument("--input");
  const raw = inputPath
    ? fs.readFileSync(path.resolve(process.cwd(), inputPath), "utf8")
    : fs.readFileSync(0, "utf8");
  const notification = JSON.parse(raw);
  const result = await sendActiveNotification(notification, { rootDir });
  console.log(JSON.stringify(result));
  if (!result.delivered) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ delivered: false, accepted: false, error: error.message }));
  process.exitCode = 1;
});
