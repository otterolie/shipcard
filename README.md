# shipcard

Checks that your Open Graph / Twitter / social meta tags actually work before you ship. Point it at `./dist` or `http://localhost:3000` — it reads the HTML, checks images, scores the page, and tells you what to fix.

Against a local folder it does as much as possible on disk: walks every HTML page (or auto-picks `dist` / `out` / `build` / `public` if you point at the repo root), resolves `og:image` / `twitter:image` to files in the tree when the path matches (even if the tag uses a production `https://…` URL), and flags relative/localhost URLs, missing alts, and dimension mismatches.

Split builds — Astro's node adapter, Next.js `standalone` output, SvelteKit's adapter-node — nest the real static site one level deeper under `client` / `public` / `static` / `www`, alongside server-only bundles. shipcard auto-descends into that subfolder when it finds one, so `shipcard ./dist` resolves images correctly even when `./dist` itself isn't the site root. If it ever picks the wrong folder anyway, a leak will say so directly and point at the folder that actually has the matching file.

If an absolute image URL points at a **different host** with no file in the folder, shipcard says so clearly — that check hits the live URL, not your tree. For pre-launch QA use `--offline`.

No SaaS, no headless browser. Just Node looking at your tags and files.

```bash
npx @otterolie/shipcard ./dist
```

## Usage

```bash
# built site
npx @otterolie/shipcard ./dist
npx @otterolie/shipcard ./out

# pre-launch: only check files in the folder (no live image fetches)
npx @otterolie/shipcard ./dist --offline

# running app
npx @otterolie/shipcard http://localhost:3000

# CI — careful with --fail-below before deploy (see below)
npx @otterolie/shipcard ./dist --offline --fail-below 85
npx @otterolie/shipcard ./dist --json > report.json

# HTML mockups of every platform card (handy in a PR)
npx @otterolie/shipcard ./dist --preview
npx @otterolie/shipcard ./dist --preview cards.html --embed
```

You can also pass a single `.html` file, or `-` for stdin.

Install as a devDependency if you prefer:

```bash
npm i -D @otterolie/shipcard
```

### Pre-launch / CI note

If your HTML already has absolute `og:image` URLs like `https://yoursite.com/og.png` but that site **isn’t deployed yet**, a normal image check will hit production and 404 — even when a fine `og.png` sits in `./dist`. That makes naive `--fail-below 80` flap.

Use one of:

- `--offline` — map URL paths onto the local folder when possible; **never** fetch remotes
- `--no-images` — skip image fetch/decode entirely (tags + platforms only)

After deploy, drop `--offline` so live URLs get a real fetch.

## What it looks for

On each page it pulls the usual tags (`title`, description, `og:*`, `twitter:*`, canonical), tries to load every distinct social image, and runs a weighted score out of 100.

Common failures it calls out:

- missing `og:title` / `og:description` / `og:image`
- localhost or relative `og:url` / canonical
- relative or plain `http://` image URLs
- image missing, unreadable, under 1200×630, or over 5 MB
- declared `og:image:width`/`height` don't match the file's real dimensions — e.g. a source photo too small to upscale, so the build silently shipped an undersized card
- image reference resolves to nothing here, but a file with the same path exists elsewhere in the folder — usually the wrong build output folder was scanned
- external image hosts when scanning a folder (live check, not local file)
- the same core tag declared twice

When something’s wrong you get a fix list with copy-paste snippets. Multi-page scans **group identical leaks** (“54 pages share this…”) instead of repeating the same block.

## Score

| Check | Points |
| --- | ---: |
| title | 10 |
| description | 10 |
| og:title | 10 |
| og:description | 10 |
| og:image | 20 |
| image loads + decodes | 15 |
| image ≥ 1200×630 | 10 |
| twitter:card | 5 |
| canonical | 5 |
| no duplicate core tags | 5 |

90+ ready · 70–89 minor leaks · under 70 blocked. For a folder, the fleet score is the average of the pages.

## Platforms

It also simulates how Meta, LinkedIn, X, Pinterest, Slack, Discord, WhatsApp, Telegram, Bluesky, Mastodon, and iMessage would build a card — field priority, truncation, image size rules. Terminal output includes a short **why** on ⚠/✕ rows (e.g. image too small for large layout). Full mockups still live under `--preview`.

Gotchas worth knowing:

- **X** wants `twitter:card` (`summary_large_image` for the big one)
- **LinkedIn** only reads OG tags and caches hard (~7 days)
- **WhatsApp** is picky about image size (aim under 600 KB)
- **Pinterest** likes tall 2:3 images
- **Discord** uses `summary_large_image` for a large embed

## Options

```
--json                 print JSON only
--fail-below <n>       exit 1 if score < n
--preview [file]       write HTML card mockups (default: shipcard-preview.html)
--embed                with --preview, inline local images as data: URIs
--offline              don't fetch remote images (local path maps only)
--no-images            skip image fetch/decode entirely
--timeout <ms>         network timeout
--output <file>        write the report to a file
--watch                re-run when files change
```

## Library

```ts
import fs from "node:fs/promises";
import {
  audit,
  advise,
  fixesForPage,
  applyFixes,
  renderTerminal,
} from "@otterolie/shipcard";

const report = await audit("./dist", { offline: true });
console.log(renderTerminal(report));

const fixes = fixesForPage(report.pages[0], report);
const html = await fs.readFile("dist/index.html", "utf8");
await fs.writeFile("dist/index.html", applyFixes(html, fixes));
```

Also exported: `auditHtml`, `auditUrl`, `auditFolder`, `extractMeta`, `scorePage`, `platformPreviews`, `renderPreviewHtml`, `planFromReport`, `version`, and the report types.

## For coding agents / LLMs

Shipcard is meant to be the social-card step in an agent loop: scan the build, get a ranked todo list, patch templates, re-run.

**CLI (preferred for tools):**

```bash
npx @otterolie/shipcard ./dist --offline --json
```

JSON always includes `plan`:

```json
{
  "summary": { "score": 62, "pagesScanned": 12, "ready": 2, "warnings": 4, "failed": 6 },
  "pages": [ "…" ],
  "plan": {
    "summary": "Fleet score 62/100 … Top action: Add a 1200×630 og:image …",
    "actions": [
      {
        "priority": 1,
        "impact": 180,
        "title": "Add a 1200×630 og:image",
        "why": "…",
        "how": "Apply on all 12 affected pages…",
        "snippet": "<meta property=\"og:image\" content=\"https://yoursite.com/og.png\">",
        "pages": ["/index.html", "/pricing.html"],
        "files": ["/abs/path/dist/index.html"]
      }
    ],
    "pages": [{ "path": "/index.html", "file": "…", "score": 55, "issues": ["…"], "actionIds": ["…"] }],
    "next": ["Start with file: …", "After edits, rebuild… and re-run: shipcard ./dist --offline --json"]
  }
}
```

**Programmatic:**

```ts
import { advise, applyFixes, fixesForPage } from "@otterolie/shipcard";
import fs from "node:fs/promises";

const { report, plan } = await advise("./dist"); // offline by default for folders
console.log(plan.summary);

for (const action of plan.actions) {
  // action.files / action.pages / action.snippet / action.how
}

// Patch one HTML file when you have a concrete path:
const page = report.pages[0];
const html = await fs.readFile(page.source, "utf8");
await fs.writeFile(page.source, applyFixes(html, fixesForPage(page, report)));
```

Agent tips:

1. Prefer `./dist` (or `./out` / `./build`) over source — shipcard reads **built HTML**.
2. Use `--offline` (or `advise()`) before deploy so production image URLs don’t 404.
3. Follow `plan.actions` in order; re-run after each meaningful change.
4. Framework apps: fix the metadata API / layout that emits tags, not only a one-off HTML file.

## Limits

- Doesn’t run your JS or open a real browser — static HTML only
- Doesn’t upload anything
- Platform mockups are approximate; production UIs move around

## License

MIT
