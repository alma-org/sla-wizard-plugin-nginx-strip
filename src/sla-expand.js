const fs = require("fs");
const path = require("path");
const os = require("os");
const jsyaml = require("js-yaml");

/**
 * Loads the OAS and SLAs, expands any SLA rate paths that use x-nginx-strip
 * stripped paths into their corresponding full OAS paths, writes temp SLA files,
 * and returns modified options pointing to the temp SLAs.
 *
 * Example: SLA rate on "/v1/chat/completions" becomes rates on
 * "/models/chatgpt/v1/chat/completions" and "/models/claude/v1/chat/completions"
 * when both OAS paths declare x-nginx-strip that strips to "/v1/chat/completions".
 *
 * @param {Object} options - Command options with oas and sla paths
 * @returns {Object} Modified options with expanded sla path (and _tempDir for cleanup)
 */
function expandSLAOptions(options) {
  const oasPath = options.oas || "./specs/oas.yaml";
  const slaPath = options.sla || "./specs/sla.yaml";

  const oasDoc = jsyaml.load(fs.readFileSync(oasPath, "utf8"));

  // Build reverse map: strippedPath -> [fullOASPath, ...]
  const reverseStripMap = {};
  for (const endpoint in oasDoc.paths) {
    const stripPrefix = oasDoc.paths[endpoint]["x-nginx-strip"];
    if (stripPrefix) {
      const strippedPath = endpoint.slice(stripPrefix.length) || "/";
      if (!reverseStripMap[strippedPath]) reverseStripMap[strippedPath] = [];
      reverseStripMap[strippedPath].push(endpoint);
    }
  }

  if (Object.keys(reverseStripMap).length === 0) {
    return options;
  }

  // Load SLAs from file or directory
  const slaContents = [];
  if (fs.lstatSync(slaPath).isDirectory()) {
    fs.readdirSync(slaPath).forEach((file) => {
      if (
        file.endsWith(".yaml") ||
        file.endsWith(".yml") ||
        file.endsWith(".json")
      ) {
        slaContents.push(
          jsyaml.load(fs.readFileSync(path.join(slaPath, file), "utf8")),
        );
      }
    });
  } else {
    slaContents.push(jsyaml.load(fs.readFileSync(slaPath, "utf8")));
  }

  // Expand SLA rates: replace stripped paths with their full OAS paths
  const expandedSLAs = slaContents.map((sla) => {
    const expanded = JSON.parse(JSON.stringify(sla));
    const rates = expanded.plan && expanded.plan.rates;
    if (!rates) return expanded;

    for (const endpoint of Object.keys(rates)) {
      if (reverseStripMap[endpoint]) {
        const rateSpec = rates[endpoint];
        delete rates[endpoint];
        for (const fullPath of reverseStripMap[endpoint]) {
          rates[fullPath] = rateSpec;
        }
      }
    }
    return expanded;
  });

  // Write expanded SLAs to a temp directory
  const tempDir = path.join(os.tmpdir(), `sla-wizard-strip-${Date.now()}`);
  const tempSlaDir = path.join(tempDir, "slas");
  fs.mkdirSync(tempSlaDir, { recursive: true });
  expandedSLAs.forEach((sla, i) => {
    fs.writeFileSync(path.join(tempSlaDir, `sla-${i}.yaml`), jsyaml.dump(sla));
  });

  return Object.assign({}, options, { sla: tempSlaDir, _tempDir: tempDir });
}

function cleanupTempDir(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { expandSLAOptions, cleanupTempDir };
