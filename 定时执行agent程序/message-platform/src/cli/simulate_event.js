const fs = require("fs");
const { processFeishuBody } = require("../app/process_event");

async function main() {
  const file = process.argv[2];
  const body = file ? JSON.parse(fs.readFileSync(file, "utf8")) : JSON.parse(fs.readFileSync(0, "utf8"));
  const forceEnabled = process.argv.includes("--force-enabled");
  const send = !process.argv.includes("--no-send");
  const result = await processFeishuBody(body, { forceEnabled, send });
  console.log(JSON.stringify(result, null, 2));
  if (!result.accepted) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
