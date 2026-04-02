const { expect } = require("chai");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const slaWizard = require("sla-wizard");
const nginxStripPlugin = require("../index.js");

slaWizard.use(nginxStripPlugin);

const CLI_PATH = path.join(__dirname, "cli-with-plugin.js");
const OAS_PATH = path.join(__dirname, "../test-specs/hpc-oas.yaml");
const SLA_DIR = path.join(__dirname, "../test-specs/slas");
const OUTPUT_DIR = path.join(__dirname, "./test-plugin-output");

// Sanitized endpoint strings as produced by sla-wizard's sanitizeEndpoint:
// "/models/chatgpt/v1/chat/completions" -> "modelschatgptv1chatcompletions"
// "/models/claude/v1/chat/completions"  -> "modelscladev1chatcompletions"
const CHATGPT_SANITIZED = "modelschatgptv1chatcompletions";
const CLAUDE_SANITIZED = "modelsclaudev1chatcompletions";
const STRIPPED_PATH = "/v1/chat/completions";

describe("sla-wizard-plugin-nginx-strip Test Suite", function () {
  this.timeout(15000);

  before(function () {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  });

  after(function () {
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  // ─── Unit tests ───────────────────────────────────────────────────────────

  describe("applyStripToConfig (unit)", function () {
    const { applyStripToConfig } = nginxStripPlugin;

    it("replaces $uri_original with the stripped path in a location block", function () {
      const input = [
        `location /sla-user_plan_${CHATGPT_SANITIZED}_POST {`,
        `    rewrite /sla-user_plan_${CHATGPT_SANITIZED}_POST $uri_original break;`,
        `    proxy_pass http://localhost:8000;`,
        `}`,
      ].join("\n");

      const result = applyStripToConfig(input, {
        [CHATGPT_SANITIZED]: STRIPPED_PATH,
      });

      expect(result).to.include(`${STRIPPED_PATH} break;`);
      expect(result).to.not.include("$uri_original");
    });

    it("replaces $uri_original for multiple endpoints in one pass", function () {
      const input = [
        `rewrite /x_${CHATGPT_SANITIZED}_POST $uri_original break;`,
        `rewrite /x_${CLAUDE_SANITIZED}_POST $uri_original break;`,
      ].join("\n");

      const result = applyStripToConfig(input, {
        [CHATGPT_SANITIZED]: STRIPPED_PATH,
        [CLAUDE_SANITIZED]: STRIPPED_PATH,
      });

      expect(result).to.not.include("$uri_original");
      expect(result.match(new RegExp(STRIPPED_PATH, "g"))).to.have.lengthOf(2);
    });

    it("leaves unrelated $uri_original lines untouched", function () {
      const input = [
        `rewrite /unrelated_endpoint_GET $uri_original break;`,
        `rewrite /x_${CHATGPT_SANITIZED}_POST $uri_original break;`,
      ].join("\n");

      const result = applyStripToConfig(input, {
        [CHATGPT_SANITIZED]: STRIPPED_PATH,
      });

      // The chatgpt line is stripped; the unrelated line is preserved
      expect(result).to.include("$uri_original");
      const lines = result.split("\n");
      expect(lines[0]).to.include("$uri_original");
      expect(lines[1]).to.include(STRIPPED_PATH);
    });

    it("returns config unchanged when stripMap is empty", function () {
      const input = `rewrite /x_${CHATGPT_SANITIZED}_POST $uri_original break;`;
      const result = applyStripToConfig(input, {});
      expect(result).to.equal(input);
    });
  });

  // ─── Programmatic API tests ───────────────────────────────────────────────

  describe("Programmatic API", function () {
    it("exposes configNginxStrip on slaWizard", function () {
      expect(slaWizard.configNginxStrip).to.be.a("function");
    });

    it("exposes addToStripConfd on slaWizard", function () {
      expect(slaWizard.addToStripConfd).to.be.a("function");
    });

    describe("configNginxStrip", function () {
      const outDir = path.join(OUTPUT_DIR, "prog-config-nginx-strip");

      before(function () {
        slaWizard.configNginxStrip({ outDir, oas: OAS_PATH, sla: SLA_DIR });
      });

      it("generates nginx.conf", function () {
        expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.true;
      });

      it("generates conf.d directory with .conf files", function () {
        const confDDir = path.join(outDir, "conf.d");
        expect(fs.existsSync(confDDir)).to.be.true;
        const files = fs.readdirSync(confDDir).filter((f) => f.endsWith(".conf"));
        expect(files.length).to.be.greaterThan(0);
      });

      it("uses stripped path instead of $uri_original in conf.d location blocks", function () {
        const confDDir = path.join(outDir, "conf.d");
        const confFiles = fs
          .readdirSync(confDDir)
          .filter((f) => f.endsWith(".conf"));

        for (const file of confFiles) {
          const content = fs.readFileSync(path.join(confDDir, file), "utf8");
          // Any rewrite for a chatgpt or claude endpoint must use the stripped path
          const chatgptRewrites = content.match(
            new RegExp(`rewrite.*${CHATGPT_SANITIZED}.*break;`, "g"),
          );
          const claudeRewrites = content.match(
            new RegExp(`rewrite.*${CLAUDE_SANITIZED}.*break;`, "g"),
          );

          if (chatgptRewrites) {
            chatgptRewrites.forEach((line) => {
              expect(line).to.include(STRIPPED_PATH);
              expect(line).to.not.include("$uri_original");
            });
          }
          if (claudeRewrites) {
            claudeRewrites.forEach((line) => {
              expect(line).to.include(STRIPPED_PATH);
              expect(line).to.not.include("$uri_original");
            });
          }
        }
      });

      it("nginx.conf URI rewrite rules still match the full public paths", function () {
        const content = fs.readFileSync(
          path.join(outDir, "nginx.conf"),
          "utf8",
        );
        // nginx-confd keeps if-based URI routing in nginx.conf (full paths in conditions)
        // while location blocks (with sanitized names) move to conf.d/
        expect(content).to.include("/models/chatgpt/v1/chat/completions");
        expect(content).to.include("/models/claude/v1/chat/completions");
      });

      it("nginx.conf includes the conf.d directory", function () {
        const content = fs.readFileSync(
          path.join(outDir, "nginx.conf"),
          "utf8",
        );
        expect(content).to.include("include conf.d/*.conf");
      });
    });

    describe("addToStripConfd", function () {
      const outDir = path.join(OUTPUT_DIR, "prog-add-to-strip-confd");

      before(function () {
        slaWizard.addToStripConfd({ outDir, oas: OAS_PATH, sla: SLA_DIR });
      });

      it("does NOT generate nginx.conf", function () {
        expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.false;
      });

      it("generates conf.d directory with .conf files", function () {
        const confDDir = path.join(outDir, "conf.d");
        expect(fs.existsSync(confDDir)).to.be.true;
        const files = fs.readdirSync(confDDir).filter((f) => f.endsWith(".conf"));
        expect(files.length).to.be.greaterThan(0);
      });

      it("conf.d files use stripped path in location blocks", function () {
        const confDDir = path.join(outDir, "conf.d");
        const confFiles = fs
          .readdirSync(confDDir)
          .filter((f) => f.endsWith(".conf"));

        let foundStrippedRewrite = false;
        for (const file of confFiles) {
          const content = fs.readFileSync(path.join(confDDir, file), "utf8");
          if (content.includes(CHATGPT_SANITIZED) || content.includes(CLAUDE_SANITIZED)) {
            expect(content).to.not.include("$uri_original");
            expect(content).to.include(STRIPPED_PATH);
            foundStrippedRewrite = true;
          }
        }
        expect(foundStrippedRewrite).to.be.true;
      });
    });
  });

  // ─── CLI tests ────────────────────────────────────────────────────────────

  describe("CLI Usage", function () {
    it("config-nginx-strip command generates nginx.conf and conf.d/", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-config-nginx-strip");
      execSync(
        `node "${CLI_PATH}" config-nginx-strip -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`,
      );
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.true;
      expect(fs.existsSync(path.join(outDir, "conf.d"))).to.be.true;
    });

    it("add-to-strip-confd command generates conf.d/ without nginx.conf", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-add-to-strip-confd");
      execSync(
        `node "${CLI_PATH}" add-to-strip-confd -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`,
      );
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.false;
      expect(fs.existsSync(path.join(outDir, "conf.d"))).to.be.true;
    });

    it("CLI output conf.d files use the stripped path", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-strip-verify");
      execSync(
        `node "${CLI_PATH}" config-nginx-strip -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`,
      );

      const confDDir = path.join(outDir, "conf.d");
      const confFiles = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"));

      expect(confFiles.length).to.be.greaterThan(0);

      let foundStrippedRewrite = false;
      for (const file of confFiles) {
        const content = fs.readFileSync(path.join(confDDir, file), "utf8");
        if (content.includes(CHATGPT_SANITIZED) || content.includes(CLAUDE_SANITIZED)) {
          expect(content).to.not.include("$uri_original");
          expect(content).to.include(STRIPPED_PATH);
          foundStrippedRewrite = true;
        }
      }
      expect(foundStrippedRewrite).to.be.true;
    });
  });
});
