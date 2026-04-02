#!/usr/bin/env node
/**
 * CLI wrapper for tests: loads sla-wizard, registers the nginx-strip plugin,
 * then delegates to sla-wizard's CLI runner.
 *
 * Usage: node cli-with-plugin.js <command> [options]
 */
const slaWizard = require("sla-wizard");
const nginxStripPlugin = require("../index.js");

slaWizard.use(nginxStripPlugin);

slaWizard.program.parse(process.argv);
