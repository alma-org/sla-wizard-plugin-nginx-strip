const fs = require("fs");
const path = require("path");
const jsyaml = require("js-yaml");
const { sanitizeEndpoint } = require("./sanitize");

/**
 * Replaces $uri_original with the stripped path in rewrite directives
 * that reference the given sanitized endpoint name.
 *
 * Targets lines of the form:
 *   rewrite /...<sanitized>_METHOD $uri_original break;
 *
 * @param {string} configContent - nginx config file content
 * @param {Object} stripMap - Map of sanitizedEndpoint -> strippedPath
 * @returns {string} Modified config content
 */
function applyStripToConfig(configContent, stripMap) {
  for (const sanitized in stripMap) {
    const strippedPath = stripMap[sanitized];
    const regex = new RegExp(
      `(rewrite\\s+\\/\\S*${sanitized}_\\w+\\s+)\\$uri_original(\\s+break;)`,
      "g",
    );
    configContent = configContent.replace(regex, `$1${strippedPath}$2`);
  }
  return configContent;
}

/**
 * Reads the OAS file, finds x-nginx-strip extensions, and rewrites the
 * generated nginx config files so that rewrite directives use the stripped
 * path instead of $uri_original for matching endpoints.
 *
 * @param {string} outDir - Output directory containing nginx.conf and conf.d/
 * @param {string} oasPath - Path to the OAS file
 */
function applyStripTransformations(outDir, oasPath) {
  const oasDoc = jsyaml.load(fs.readFileSync(oasPath, "utf8"));

  // Build map: sanitizedEndpoint -> strippedPath
  const stripMap = {};
  for (const endpoint in oasDoc.paths) {
    const stripPrefix = oasDoc.paths[endpoint]["x-nginx-strip"];
    if (stripPrefix) {
      const sanitized = sanitizeEndpoint(endpoint);
      const strippedPath = endpoint.slice(stripPrefix.length) || "/";
      stripMap[sanitized] = strippedPath;
    }
  }

  if (Object.keys(stripMap).length === 0) return;

  // Post-process nginx.conf
  const nginxConfPath = path.join(outDir, "nginx.conf");
  if (fs.existsSync(nginxConfPath)) {
    fs.writeFileSync(
      nginxConfPath,
      applyStripToConfig(fs.readFileSync(nginxConfPath, "utf8"), stripMap),
    );
  }

  // Post-process conf.d/*.conf
  const confDDir = path.join(outDir, "conf.d");
  if (fs.existsSync(confDDir)) {
    fs.readdirSync(confDDir).forEach((file) => {
      if (file.endsWith(".conf")) {
        const filePath = path.join(confDDir, file);
        fs.writeFileSync(
          filePath,
          applyStripToConfig(fs.readFileSync(filePath, "utf8"), stripMap),
        );
      }
    });
  }
}

module.exports = { applyStripToConfig, applyStripTransformations };
