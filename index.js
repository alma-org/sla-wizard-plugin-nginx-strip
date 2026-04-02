const { configNginxStrip, addToStripConfd } = require("./src/commands");
const { applyStripToConfig, applyStripTransformations } = require("./src/nginx-transform");
const { expandSLAOptions } = require("./src/sla-expand");

/**
 * Plugin that wraps sla-wizard-nginx-confd and adds support for the
 * x-nginx-strip OAS extension. For each path that declares x-nginx-strip,
 * the generated nginx rewrite directives will forward the stripped path to
 * the backend instead of the full original URI.
 *
 * SLAs may reference the stripped (backend) path in their rates section.
 * This plugin expands those references to all matching full OAS paths
 * before generation, then post-processes the output to apply the strip.
 *
 * Example OAS path:
 *   /models/chatgpt/v1/chat/completions:
 *     x-nginx-strip: "/models/chatgpt"
 *
 * This causes nginx to receive /models/chatgpt/v1/chat/completions and
 * proxy /v1/chat/completions to the backend server.
 *
 * @param {Object} program - Commander program instance
 * @param {Object} ctx - Context with utils and generate functions
 */
function apply(program, ctx) {
  program
    .command("config-nginx-strip")
    .description(
      "Generate nginx configuration with x-nginx-strip path stripping support",
    )
    .requiredOption(
      "-o, --outDir <outputDirectory>",
      "Output directory for nginx.conf and conf.d/",
    )
    .option(
      "--sla <slaPath>",
      "One of: 1) single SLA, 2) folder of SLAs, 3) URL returning an array of SLA objects",
      "./specs/sla.yaml",
    )
    .option("--oas <pathToOAS>", "Path to an OAS v3 file.", "./specs/oas.yaml")
    .option(
      "--customTemplate <customTemplate>",
      "Custom proxy configuration template.",
    )
    .option(
      "--authLocation <authLocation>",
      "Where to look for the authentication parameter. Must be one of: header, query, url.",
      "header",
    )
    .option(
      "--authName <authName>",
      'Name of the authentication parameter, such as "token" or "apikey".',
      "apikey",
    )
    .option("--proxyPort <proxyPort>", "Port on which the proxy is running", 80)
    .action(function (options) {
      configNginxStrip(options, ctx);
    });

  program
    .command("add-to-strip-confd")
    .description(
      "Generate conf.d files with x-nginx-strip path stripping (no nginx.conf)",
    )
    .requiredOption(
      "-o, --outDir <outputDirectory>",
      "Output directory for conf.d/",
    )
    .option(
      "--sla <slaPath>",
      "One of: 1) single SLA, 2) folder of SLAs, 3) URL returning an array of SLA objects",
      "./specs/sla.yaml",
    )
    .option("--oas <pathToOAS>", "Path to an OAS v3 file.", "./specs/oas.yaml")
    .option(
      "--customTemplate <customTemplate>",
      "Custom proxy configuration template.",
    )
    .option(
      "--authLocation <authLocation>",
      "Where to look for the authentication parameter. Must be one of: header, query, url.",
      "header",
    )
    .option(
      "--authName <authName>",
      'Name of the authentication parameter, such as "token" or "apikey".',
      "apikey",
    )
    .option("--proxyPort <proxyPort>", "Port on which the proxy is running", 80)
    .action(function (options) {
      addToStripConfd(options, ctx);
    });
}

module.exports = {
  apply,
  configNginxStrip,
  addToStripConfd,
  applyStripToConfig,
  applyStripTransformations,
  expandSLAOptions,
};
