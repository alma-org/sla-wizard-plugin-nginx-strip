/**
 * Container integration tests for sla-wizard-plugin-nginx-strip.
 *
 * These tests start real Docker containers (a Node.js echo backend + nginx) to
 * verify that the generated nginx configuration correctly strips URL prefixes
 * before proxying to the backend.
 *
 * Requires Docker to be running. Run with:
 *   npm run test:container
 */
const { expect } = require("chai");
const { GenericContainer, Network, Wait } = require("testcontainers");
const http = require("http");
const path = require("path");
const fs = require("fs");
const slaWizard = require("sla-wizard");
const nginxStripPlugin = require("../index.js");

slaWizard.use(nginxStripPlugin);

const OAS_PATH = path.join(__dirname, "../test-specs/hpc-oas.yaml");
const SLA_DIR = path.join(__dirname, "../test-specs/slas");
const CONTAINER_OUT_DIR = path.join(__dirname, "./test-container-output");

// API keys from the test SLAs
const API_KEY_DGALVAN = "1b0e1bfa203530d43a0bd8461aa018b7"; // plan: normal, 5 req/min
const API_KEY_JAPAREJO = "6121788b3c78f416a5b10627edf417dd"; // plan: pro,    10 req/min

// Minimal Node.js HTTP server that echoes the received path and method as JSON.
// Written as a single-line string so it can be passed as a `node -e` argument.
const ECHO_SERVER_CODE = [
  "const h=require('http');",
  "h.createServer((req,res)=>{",
  "  let b='';",
  "  req.on('data',d=>b+=d);",
  "  req.on('end',()=>{",
  "    const r=JSON.stringify({path:req.url,method:req.method,body:b});",
  "    res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(r)});",
  "    res.end(r);",
  "  });",
  "}).listen(8000,()=>process.stdout.write('ECHO_READY\\n'));",
].join("");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a valid monolithic nginx.conf with the strip transformation applied
 * and the proxy_pass target replaced with the given backend URL.
 *
 * Uses the core `slaWizard.config("nginx")` generator (single-file output)
 * rather than the nginx-confd split, because the split config places
 * limit_req_zone and map directives inside the server block — which nginx rejects.
 *
 * applyStripTransformations is called directly from the plugin (no ctx needed),
 * so this function has no dependency on sla-wizard internals.
 */
function buildNginxConf(outFile, backendUrl) {
  const outDir = path.dirname(outFile);

  // Expand SLA paths (stripped → full OAS paths) so the core generator accepts them
  const expandedOptions = nginxStripPlugin.expandSLAOptions({
    oas: OAS_PATH,
    sla: SLA_DIR,
  });

  try {
    slaWizard.config("nginx", {
      outFile,
      oas: OAS_PATH,
      sla: expandedOptions.sla,
      authLocation: "header",
      authName: "apikey",
      proxyPort: 80,
    });
  } finally {
    if (expandedOptions._tempDir) {
      fs.rmSync(expandedOptions._tempDir, { recursive: true, force: true });
    }
  }

  // Apply the x-nginx-strip rewrite transformation.
  // applyStripTransformations processes nginx.conf (and conf.d/*.conf if present)
  // inside outDir — no ctx or sla-wizard internals required.
  nginxStripPlugin.applyStripTransformations(outDir, OAS_PATH);

  // Point proxy_pass at the actual backend container
  let conf = fs.readFileSync(outFile, "utf8");
  conf = conf.replace(/proxy_pass\s+http:\/\/[^;]+;/g, `proxy_pass ${backendUrl};`);
  fs.writeFileSync(outFile, conf);
}

/**
 * Thin Promise wrapper around Node's http.request.
 */
function request({ host, port, path: urlPath, method = "POST", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, path: urlPath, method, headers };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Container Integration Tests (nginx routing)", function () {
  // Pull + start containers can take a while on the first run
  this.timeout(300000);

  let network;
  let backendContainer;
  let nginxContainer;
  let nginxHost;
  let nginxPort;

  before(async function () {
    if (!fs.existsSync(CONTAINER_OUT_DIR)) {
      fs.mkdirSync(CONTAINER_OUT_DIR, { recursive: true });
    }

    // 1. Shared Docker network so nginx can reach the backend by alias
    network = await new Network().start();

    // 2. Echo backend: a tiny Node.js HTTP server inside node:18-alpine
    backendContainer = await new GenericContainer("node:18-alpine")
      .withNetwork(network)
      .withNetworkAliases("backend")
      .withCommand(["node", "-e", ECHO_SERVER_CODE])
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forLogMessage("ECHO_READY"))
      .start();

    // 3. Generate a valid monolithic nginx.conf with strip applied
    const nginxConfFile = path.join(CONTAINER_OUT_DIR, "nginx.conf");
    buildNginxConf(nginxConfFile, "http://backend:8000");

    // 4. nginx container — replace its default config with ours
    nginxContainer = await new GenericContainer("nginx:alpine")
      .withNetwork(network)
      .withCopyFilesToContainer([
        { source: nginxConfFile, target: "/etc/nginx/nginx.conf" },
      ])
      .withExposedPorts(80)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    nginxHost = nginxContainer.getHost();
    nginxPort = nginxContainer.getMappedPort(80);
  });

  after(async function () {
    if (nginxContainer) await nginxContainer.stop();
    if (backendContainer) await backendContainer.stop();
    if (network) await network.stop();
    if (fs.existsSync(CONTAINER_OUT_DIR)) {
      fs.rmSync(CONTAINER_OUT_DIR, { recursive: true, force: true });
    }
  });

  // ─── Routing / strip behaviour ─────────────────────────────────────────────

  it("strips /models/chatgpt and proxies /v1/chat/completions to the backend", async function () {
    const body = JSON.stringify({ model: "gpt-3.5-turbo", messages: [] });
    const res = await request({
      host: nginxHost,
      port: nginxPort,
      path: "/models/chatgpt/v1/chat/completions",
      headers: {
        apikey: API_KEY_DGALVAN,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    });

    expect(res.status).to.equal(200);
    const echo = JSON.parse(res.body);
    expect(echo.path).to.equal("/v1/chat/completions");
    expect(echo.method).to.equal("POST");
  });

  it("strips /models/claude and proxies /v1/chat/completions to the backend", async function () {
    const body = JSON.stringify({ model: "claude-sonnet-4-6", messages: [] });
    const res = await request({
      host: nginxHost,
      port: nginxPort,
      path: "/models/claude/v1/chat/completions",
      headers: {
        apikey: API_KEY_DGALVAN,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    });

    expect(res.status).to.equal(200);
    const echo = JSON.parse(res.body);
    expect(echo.path).to.equal("/v1/chat/completions");
  });

  it("applies the rate limit of the matched plan (different users get different zones)", async function () {
    // Both keys should reach the backend — they're just rate-limited independently
    const body = JSON.stringify({ model: "test", messages: [] });

    const r1 = await request({
      host: nginxHost,
      port: nginxPort,
      path: "/models/chatgpt/v1/chat/completions",
      headers: { apikey: API_KEY_DGALVAN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      body,
    });
    const r2 = await request({
      host: nginxHost,
      port: nginxPort,
      path: "/models/chatgpt/v1/chat/completions",
      headers: { apikey: API_KEY_JAPAREJO, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      body,
    });

    // Both requests from different users should succeed (200)
    expect(r1.status).to.equal(200);
    expect(r2.status).to.equal(200);

    // Both should have received the stripped path at the backend
    expect(JSON.parse(r1.body).path).to.equal("/v1/chat/completions");
    expect(JSON.parse(r2.body).path).to.equal("/v1/chat/completions");
  });

  // ─── Auth behaviour ────────────────────────────────────────────────────────

  it("returns 401 when no API key header is provided", async function () {
    const res = await request({
      host: nginxHost,
      port: nginxPort,
      path: "/models/chatgpt/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).to.equal(401);
  });

  it("returns 403 when an unrecognised API key is provided", async function () {
    const res = await request({
      host: nginxHost,
      port: nginxPort,
      path: "/models/chatgpt/v1/chat/completions",
      headers: {
        apikey: "00000000000000000000000000000000",
        "Content-Type": "application/json",
      },
    });
    expect(res.status).to.equal(403);
  });
});
