const http = require("http");
const { processFeishuBody } = require("./process_event");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/events/feishu")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  try {
    const bodyText = await readBody(req);
    const body = JSON.parse(bodyText || "{}");
    const result = await processFeishuBody(body);
    if (result.challenge) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: result.challenge }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, accepted: result.accepted, reason: result.reason || "" }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

function startServer(port = Number(process.env.PORT || 8787)) {
  const server = http.createServer((req, res) => handle(req, res));
  server.listen(port, () => {
    console.log(JSON.stringify({ ok: true, message: "bridge server listening", port }));
  });
  return server;
}

function commandLinePort() {
  const arg = process.argv.find((item) => item.startsWith("--port="));
  return arg ? Number(arg.slice("--port=".length)) : undefined;
}

if (require.main === module) startServer(commandLinePort());

module.exports = { startServer, handle };
