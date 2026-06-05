# Shipcard

> Catch broken social cards before you ship.

A local-first preflight checker for Open Graph, X/Twitter, Pinterest, WhatsApp, Telegram, Bluesky, Mastodon and every other major platform's link previews. Point it at a folder (`./dist`, `./out`, `./build`) or a running dev server and Shipcard tells you exactly what's leaking — with actionable fixes and a visual preview you can drop in PRs.

No hosted services. No browser. No code execution. Just your static HTML + the images it references.

Install once, run anywhere:

```bash
npx shipcard ./dist --preview
open shipcard-preview.html
```

## Install

Run it on demand:

```bash
npx shipcard ./dist
```

Or install as a dev dependency:

```bash
npm install --save-dev shipcard
```

## Quickstart

Audit a running dev server:

```bash
npx shipcard http://localhost:3000
```

Audit a static site folder:

```bash
npx shipcard ./dist
npx shipcard ./out
npx shipcard ./build
```

Output JSON for CI:

```bash
npx shipcard ./dist --json > shipcard-report.json
```

Fail the build if score drops below a threshold:

```bash
npx shipcard ./dist --fail-below 85
```

Generate a visual preview of every platform card:

```bash
npx shipcard ./dist --preview                       # writes ./shipcard-preview.html
npx shipcard ./dist --preview review.html           # custom path
open shipcard-preview.html                          # macOS
```

## What it checks

For every page Shipcard scans it pulls the real tags, validates the images (fetch + decode + dimensions + size), runs platform-specific simulations, and gives you a 0-100 score plus concrete "Fix it" suggestions (with copy-paste snippets).

Core tags it always validates:

- `<title>` and `og:title`
- `meta[name="description"]` and `og:description`
- `og:image` (resolved, fetched, and decoded)
- `og:url`
- `link[rel="canonical"]`
- `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`

It then runs a deck check that flags:

- Missing OG / Twitter tags
- Localhost URLs leaking into `og:url` or `canonical`
- Relative `og:image` paths
- Images that can't be fetched or decoded
- Images smaller than 1200x630
- Images larger than 5 MB
- Duplicate core tags (multiple `og:title`, `og:image`, `canonical`, etc.)

## Scoring

Pages are scored out of 100 using a weighted model:

| Check                                  | Weight |
| -------------------------------------- | -----: |
| Title found                            |     10 |
| Description found                      |     10 |
| og:title found                         |     10 |
| og:description found                   |     10 |
| og:image found                         |     20 |
| Image fetchable / readable             |     15 |
| Image at least 1200x630                |     10 |
| twitter:card found                     |      5 |
| Canonical link found                   |      5 |
| No duplicate core tags                 |      5 |

Status thresholds:

- **90–100** — Ready to ship
- **70–89**  — Minor leaks
- **0–69**   — Ship blocked

Folder targets report a fleet score (the mean across all scanned pages).

## Platform previews

Shipcard simulates how **every major platform** parses and renders your card — 100% locally, no network calls to the platforms. Rules for field priority, truncation, image dimensions, layout decisions and warnings are derived from each platform's own developer documentation.

Supported platforms (11 and growing):

| Platform     | Primary tags              | Recommended image          | Notable rules / gotchas |
| ------------ | ------------------------- | ---------------------------- | ----------------------- |
| Meta (FB)    | `og:*`                    | ≥600×315 (large), 200×200 min | Falls back to small or none below thresholds. |
| LinkedIn     | `og:*` only               | 1200×627 (landscape)         | Ignores all `twitter:*`. Caches ~7 days — use Post Inspector to refresh. |
| X (Twitter)  | `twitter:*` → `og:*`      | 1200×675 or 300×157+ for large | `twitter:card="summary_large_image"` for hero. |
| Pinterest    | `og:*`                    | 1000×1500 (2:3 vertical ideal) | Extremely visual; tall pins get better distribution. |
| Slack        | `og:*` → `twitter:*`      | Any (inline unfurl)          | Clean title + desc matter most. |
| Discord      | `og:*` → `twitter:*`      | Any                          | `summary_large_image` → big embed hero. |
| WhatsApp     | `og:*`                    | 1200×630, **<600 KB**        | Strict on size; http or huge images often silent-fail. |
| Telegram     | `og:*` (+ `twitter:card`) | 1200×630                     | Respects `summary_large_image` for large preview. |
| Bluesky      | `og:*` (+ twitter fallbacks) | 1200×630 or square        | Modern clean cards; image quality is highly visible. |
| Mastodon     | `og:*` / `twitter:*`      | Flexible (1200×630 good)     | Per-instance caching; some servers are picky. |
| iMessage     | `og:title` + `og:image`   | Square-ish (≥144×144)        | Crops to square thumbnail. |

In the terminal you get a compact summary:

```
Platform previews:
  ✓ Meta (Facebook)  → Large image card
  ✓ LinkedIn         → Large image card
  ✓ X (Twitter)      → Large image card
  ✓ Pinterest        → Summary card
  ✓ Slack            → Inline preview
  ✓ Discord          → Large image card
  ✓ WhatsApp         → Large image card
  ✓ Telegram         → Summary card
  ✓ Bluesky          → Large image card
  ✓ Mastodon         → Summary card
  ✓ iMessage         → Summary card
```

In JSON you get the full per-platform breakdown: which source each platform used, whether the title or description was truncated, what card layout will render, and platform-specific warnings.

The `--preview` flag writes a self-contained HTML file with a visual mockup of every card on every page — open it in any browser, share it in PRs, or screenshot it for design review.

## CLI flags

| Flag                       | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| `--json`                   | Print the audit report as JSON and nothing else.         |
| `--fail-below <score>`     | Exit with code 1 if the overall score is below this.     |
| `--preview [file]`         | Write a visual HTML preview. Defaults to `./shipcard-preview.html`. |
| `--timeout <ms>`           | Network timeout for fetches (default 10–15s).            |
| `--no-images`              | Skip image fetching / decoding (faster, less coverage).  |
| `--output <file>`          | Write the report (JSON or terminal text) to a file.      |
| `--watch`                  | Watch the target and re-run on changes (ideal for dev).  |
| `--embed`                  | When using --preview on a folder: embed local images as data:base64 so the HTML is fully portable. |

## Example terminal output

```
Shipcard

Target: ./dist
Pages scanned: 4
Fleet score: 86/100
Status: Minor leaks found

Pages:
✓ /index.html       94  Ready to ship
⚠ /pricing.html     78  Minor leaks
✕ /blog/post.html   52  Ship blocked

/pricing.html
Leaks:
• og:image is 800x420. Recommended: 1200x630.
• twitter:card is missing.
```

## Programmatic use

```ts
import { auditFolder, renderTerminal } from "shipcard";

const report = await auditFolder("./dist");
console.log(renderTerminal(report));
```

The full `AuditReport` type — including per-page metadata, image audit, checks, and warnings — is exported from the package root.

Also exported for convenience: `version`, a unified `audit(target, options?)` (auto-dispatches URL / .html file / folder), and `applyFixes(html, fixes)` to close the "detect → improve" loop.

## Using with AI Agents, Tool Calling & MCP

shipcard is designed to be *trivial* for AI coding agents and tool-calling systems:

```ts
import { audit, fixesForPage, applyFixes, version } from "shipcard";
import fs from "node:fs/promises";

const report = await audit("./dist");           // or url, or single .html file, or "-"
const fixes = fixesForPage(report.pages[0], report);
const original = await fs.readFile("path/to/index.html", "utf8");
const patched = applyFixes(original, fixes);    // returns patched HTML string
await fs.writeFile("path/to/index.html", patched);
const newReport = await audit("./dist");
console.log("Score improved:", report.summary.score, "→", newReport.summary.score);
```

- `audit()` is the single entry point agents love.
- `Fix[]` + snippets give structured, explainable, copy-pasteable changes.
- `applyFixes` safely injects them (uses the same cheerio parser).
- Every report carries `tool`, `version`, `createdAt` for logging/compat.
- All types are plain JSON-serializable data.

**MCP / tool server example** (drop this in your agent host; no extra deps on shipcard itself):

```ts
// mcp-shipcard-server.ts (example)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { audit, fixesForPage } from "shipcard";
import { z } from "zod";

const server = new McpServer({ name: "shipcard", version: "0.1.0" });

server.tool("shipcard_audit", {
  target: z.string().describe("URL, folder, .html file, or '-' for stdin"),
  json: z.boolean().optional(),
}, async ({ target, json }) => {
  const report = await audit(target);
  return {
    content: [{ type: "text", text: json ? JSON.stringify(report, null, 2) : /* render or summary */ String(report.summary.score) }],
  };
});

server.tool("shipcard_fixes", { target: z.string() }, async ({ target }) => {
  const report = await audit(target);
  const fixes = fixesForPage(report.pages[0], report);
  return { content: [{ type: "text", text: JSON.stringify(fixes, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

See the "Programmatic use" section and `applyFixes` for more.

## What Shipcard does *not* do (yet)

- It does not execute your code. It just parses HTML and decodes images.
- It does not render pages in a browser. No Playwright, no Puppeteer.
- It does not upload your site anywhere. There is no hosted report.

## License

MIT
