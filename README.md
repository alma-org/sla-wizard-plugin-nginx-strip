# sla-wizard-plugin-nginx-strip

A plugin for [SLA Wizard](../sla-wizard) and [sla-wizard-nginx-confd](../sla-wizard-nginx-confd) that adds support for the `x-nginx-strip` OAS extension.

When a path declares `x-nginx-strip`, nginx will receive the **full public path** but forward only the **stripped backend path** to the upstream server.

```
Client → nginx:  POST /models/chatgpt/v1/chat/completions
nginx → backend: POST /v1/chat/completions
```

---

## How it works

### 1. Annotate your OAS with `x-nginx-strip`

Add the extension at the **path level** (not operation level):

```yaml
# oas.yaml
servers:
  - url: http://localhost:8000

paths:
  /models/chatgpt/v1/chat/completions:
    x-nginx-strip: "/models/chatgpt"   # strip this prefix before proxying
    post:
      ...

  /models/claude/v1/chat/completions:
    x-nginx-strip: "/models/claude"
    post:
      ...
```

### 2. Write your SLAs using the backend (stripped) path

SLAs reference the path that reaches the backend, not the public path:

```yaml
# sla.yaml
plan:
  name: normal
  rates:
    /v1/chat/completions:       # stripped (backend) path
      post:
        requests:
          - max: 5
            period: minute
```

The plugin automatically expands these references to all OAS paths that strip to the same backend path.

### 3. Run the plugin

The plugin generates nginx configuration where every `rewrite` directive in a
location block uses the stripped path instead of `$uri_original`:

```nginx
# Before (standard sla-wizard output)
location /sla-dgalvan_us_es_normal_modelschatgptv1chatcompletions_POST {
    rewrite /sla-...POST  $uri_original  break;
    proxy_pass http://localhost:8000;
    ...
}

# After (with x-nginx-strip applied)
location /sla-dgalvan_us_es_normal_modelschatgptv1chatcompletions_POST {
    rewrite /sla-...POST  /v1/chat/completions  break;
    proxy_pass http://localhost:8000;
    ...
}
```

---

## Installation

```bash
cd sla-wizard-plugin-nginx-strip
npm install
```

The plugin depends on `sla-wizard-nginx-confd` (bundled as a local dependency).

---

## Usage — CLI

Register the plugin in a CLI wrapper and call it with the same options as
`sla-wizard-nginx-confd`.

### CLI wrapper (one-time setup)

```js
// my-cli.js
const slaWizard = require("sla-wizard");
const nginxStripPlugin = require("sla-wizard-plugin-nginx-strip");

slaWizard.use(nginxStripPlugin);
slaWizard.program.parse(process.argv);
```

### `config-nginx-strip` — full config (nginx.conf + conf.d/)

```bash
node my-cli.js config-nginx-strip \
  -o ./nginx-output \
  --oas ./specs/oas.yaml \
  --sla ./specs/slas \
  --authName apikey \
  --proxyPort 80
```

Output:

```
nginx-output/
├── nginx.conf          ← server block + URI routing
└── conf.d/
    ├── sla-dgalvan_us.conf
    ├── sla-japarejo_us.conf
    └── sla-pablofm_us.conf
```

### `add-to-strip-confd` — conf.d only (no nginx.conf overwrite)

Useful for adding a new user/plan without touching the main `nginx.conf`:

```bash
node my-cli.js add-to-strip-confd \
  -o ./nginx-output \
  --oas ./specs/oas.yaml \
  --sla ./specs/slas/sla_newuser.yaml
```

### CLI options

| Option | Description | Default |
|---|---|---|
| `-o, --outDir <dir>` | Output directory | **required** |
| `--oas <path>` | Path to OAS v3 file | `./specs/oas.yaml` |
| `--sla <path>` | Single SLA file, directory of SLAs, or URL | `./specs/sla.yaml` |
| `--authLocation <loc>` | Where to read the API key: `header`, `query`, `url` | `header` |
| `--authName <name>` | API key parameter name | `apikey` |
| `--proxyPort <port>` | Port nginx listens on | `80` |
| `--customTemplate <path>` | Custom nginx config template | — |

---

## Usage — Module (programmatic)

### Setup

```js
const slaWizard = require("sla-wizard");
const nginxStripPlugin = require("sla-wizard-plugin-nginx-strip");

slaWizard.use(nginxStripPlugin);
```

`slaWizard.use` registers the plugin and exposes its functions directly on the
`slaWizard` object, injecting the sla-wizard context automatically.

### `slaWizard.configNginxStrip(options)` — full config

```js
slaWizard.configNginxStrip({
  outDir: "./nginx-output",
  oas:    "./specs/oas.yaml",
  sla:    "./specs/slas",          // file, directory, or URL
  authLocation: "header",          // optional, default: "header"
  authName:     "apikey",          // optional, default: "apikey"
  proxyPort:    80,                 // optional, default: 80
});
```

### `slaWizard.addToStripConfd(options)` — conf.d only

```js
slaWizard.addToStripConfd({
  outDir: "./nginx-output",
  oas:    "./specs/oas.yaml",
  sla:    "./specs/slas/sla_newuser.yaml",
});
```

### Using individual exports directly

The plugin also exports lower-level functions that work **without sla-wizard
context** — useful when integrating into custom pipelines:

```js
const {
  expandSLAOptions,          // resolve stripped SLA paths → full OAS paths
  applyStripTransformations, // rewrite $uri_original → stripped path in .conf files
  applyStripToConfig,        // same, but on a raw config string
} = require("sla-wizard-plugin-nginx-strip");

// Expand SLAs so the core generator accepts them
const expanded = expandSLAOptions({ oas: "./oas.yaml", sla: "./slas" });

// ... generate nginx config into outDir with slaWizard.config("nginx", ...) ...

// Apply strip transformation to all .conf files in outDir
applyStripTransformations(outDir, "./oas.yaml");

// Cleanup temp files created by expandSLAOptions
if (expanded._tempDir) fs.rmSync(expanded._tempDir, { recursive: true, force: true });
```

#### `expandSLAOptions(options)`

Reads the OAS, builds a reverse strip map (`strippedPath → [fullOASPaths]`),
loads each SLA, replaces any rate entries that reference a stripped path with
entries for all matching full OAS paths, and writes the expanded SLAs to a
temp directory.

Returns a copy of `options` with `sla` pointing at the temp directory and
`_tempDir` set to the temp path (clean it up when done).

#### `applyStripTransformations(outDir, oasPath)`

Reads the OAS from `oasPath`, then for every endpoint that declares
`x-nginx-strip`, rewrites every matching `rewrite` directive inside
`<outDir>/nginx.conf` and `<outDir>/conf.d/*.conf` — replacing `$uri_original`
with the stripped path.

#### `applyStripToConfig(configContent, stripMap)`

Lower-level string transformation. Applies `stripMap` (an object mapping
`sanitizedEndpoint → strippedPath`) to a raw nginx config string.

```js
const result = applyStripToConfig(nginxConfString, {
  modelschatgptv1chatcompletions: "/v1/chat/completions",
  modelsclaudev1chatcompletions:  "/v1/chat/completions",
});
```

---

## Generating a standalone, valid nginx.conf

The `config-nginx-strip` command produces a split config (nginx.conf +
conf.d/) via `sla-wizard-nginx-confd`. If you need a single valid monolithic
file (e.g., to mount directly in a Docker container), generate it with the
core sla-wizard generator and then apply the strip transformation:

```js
const slaWizard = require("sla-wizard");
const { expandSLAOptions, applyStripTransformations } = require("sla-wizard-plugin-nginx-strip");
const fs = require("fs");
const path = require("path");

slaWizard.use(require("sla-wizard-plugin-nginx-strip"));

const OAS = "./specs/oas.yaml";
const SLA = "./specs/slas";
const OUT_DIR = "./nginx-output";
const OUT_FILE = path.join(OUT_DIR, "nginx.conf");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 1. Expand SLAs
const expanded = expandSLAOptions({ oas: OAS, sla: SLA });

try {
  // 2. Generate monolithic nginx.conf
  slaWizard.config("nginx", {
    outFile: OUT_FILE,
    oas: OAS,
    sla: expanded.sla,
  });
} finally {
  if (expanded._tempDir) fs.rmSync(expanded._tempDir, { recursive: true, force: true });
}

// 3. Apply strip transformation in-place
applyStripTransformations(OUT_DIR, OAS);
```

---

## Complete OAS example

```yaml
openapi: 3.0.3
info:
  title: LLM Gateway API
  version: 1.0.0
servers:
  - url: http://localhost:8000

paths:
  /models/chatgpt/v1/chat/completions:
    x-nginx-strip: "/models/chatgpt"
    post:
      summary: ChatGPT completions
      operationId: postChatGPTCompletion
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ChatRequest"
      responses:
        "200":
          description: OK

  /models/claude/v1/chat/completions:
    x-nginx-strip: "/models/claude"
    post:
      summary: Claude completions
      operationId: postClaudeCompletion
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ChatRequest"
      responses:
        "200":
          description: OK
```

## Complete SLA example

```yaml
sla4oas: 1.0.0
context:
  id: sla-alice
  type: agreement
  api:
    $ref: ./oas.yaml
  apikeys:
    - my-secret-key-abc123
plan:
  name: standard
  rates:
    /v1/chat/completions:      # backend path (after stripping)
      post:
        requests:
          - max: 10
            period: minute
```

---

## Running the tests

```bash
# Unit, programmatic, and CLI tests
npm test

# Container integration tests (requires Docker)
npm run test:container
```

The container tests spin up a real `nginx:alpine` instance and a lightweight
Node.js echo server to verify end-to-end that:

- `/models/chatgpt/v1/chat/completions` is proxied to the backend as `/v1/chat/completions`
- `/models/claude/v1/chat/completions` is proxied to the backend as `/v1/chat/completions`
- Requests without an API key receive **401**
- Requests with an unrecognised API key receive **403**

---

## License

Apache License 2.0 — same as SLA Wizard.
