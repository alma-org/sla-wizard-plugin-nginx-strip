const nginxConfd = require("sla-wizard-nginx-confd");
const { expandSLAOptions, cleanupTempDir } = require("./sla-expand");
const { applyStripTransformations } = require("./nginx-transform");

/**
 * Generates full nginx config (nginx.conf + conf.d/) and applies strip transforms.
 *
 * @param {Object} options - Command options
 * @param {Object} ctx - sla-wizard context
 */
function configNginxStrip(options, ctx) {
  const expandedOptions = expandSLAOptions(options);
  try {
    nginxConfd.configNginxConfd(expandedOptions, ctx);
    applyStripTransformations(options.outDir, options.oas || "./specs/oas.yaml");
    console.log("✓ x-nginx-strip transformations applied");
  } finally {
    cleanupTempDir(expandedOptions._tempDir);
  }
}

/**
 * Generates only conf.d/ files and applies strip transforms.
 *
 * @param {Object} options - Command options
 * @param {Object} ctx - sla-wizard context
 */
function addToStripConfd(options, ctx) {
  const expandedOptions = expandSLAOptions(options);
  try {
    nginxConfd.addToConfd(expandedOptions, ctx);
    applyStripTransformations(options.outDir, options.oas || "./specs/oas.yaml");
    console.log("✓ x-nginx-strip transformations applied");
  } finally {
    cleanupTempDir(expandedOptions._tempDir);
  }
}

module.exports = { configNginxStrip, addToStripConfd };
