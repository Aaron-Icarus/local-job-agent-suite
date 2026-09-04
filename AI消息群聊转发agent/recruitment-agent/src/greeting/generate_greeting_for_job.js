const { createGreetingResponse, formatGreetingText } = require("./job_greeting_agent");
const displayId = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const asJson = process.argv.includes("--json");

function usage() {
  console.error("Usage: node src/greeting/generate_greeting_for_job.js <display_id> [--json]");
}

async function main() {
  if (!displayId) {
    usage();
    process.exitCode = 1;
    return;
  }
  const result = await createGreetingResponse({ display_id: displayId });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatGreetingText(result));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
