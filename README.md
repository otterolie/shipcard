# shipcard

Checks your Open Graph, Twitter, and social link preview tags before you ship. Point it at a build folder (`./dist`), a single `.html` file, stdin (`-`), or a live URL (`http://localhost:3000`).

```bash
npx @otterolie/shipcard ./dist
```

Or install it as a dev dependency:

```bash
npm i -D @otterolie/shipcard
```

## Usage

```bash
# Audit a built site
npx @otterolie/shipcard ./dist

# Pre-launch check: resolve image paths on disk, skip remote fetches
npx @otterolie/shipcard ./dist --offline

# Audit a running dev server or deployed page
npx @otterolie/shipcard http://localhost:3000

# Audit a single HTML file or stdin
npx @otterolie/shipcard ./dist/index.html
cat dist/index.html | npx @otterolie/shipcard -

# CI gate and JSON output
npx @otterolie/shipcard ./dist --offline --fail-below 85
npx @otterolie/shipcard ./dist --offline --json > report.json

# Generate a standalone HTML preview of all platform cards
npx @otterolie/shipcard ./dist --preview
npx @otterolie/shipcard ./dist --preview cards.html --embed
```

### Pre-launch note

If your HTML already references production image URLs like `https://example.com/og.png` before the site is deployed, shipcard maps matching paths onto your local build folder automatically. For images that do not exist locally, a live fetch will 404 unless you pass:

- `--offline` to resolve local files and skip remote fetches
- `--no-images` to skip image validation altogether

After deploy, drop `--offline` to verify live URLs over HTTP.

## What it checks

For each page, shipcard extracts `<title>`, `<meta name="description">`, `og:*`, `twitter:*`, and `<link rel="canonical">`, validates referenced social images (`og:image` and `twitter:image`), and reports:

- Missing `og:title`, `og:description`, `og:image`, `twitter:card`, or canonical tags
- Localhost or relative `og:url`, `canonical`, and `og:image` URLs
- Plain `http://` image URLs
- Missing, undecodable, SVG, data-URI, undersized (`< 1200x630`), or oversized (`> 5 MB`) images
- Mismatches between declared `og:image:width`/`height` and actual image dimensions
- Missing images that exist under another subfolder (common when scanning the wrong build directory)
- Duplicate core meta tags

Folder scans auto-detect standard build directories (`dist`, `out`, `build`, `public`, `.output`, `export`) when run from a repo root, and auto-descend into split client/server output directories (`client`, `public`, `static`, `www`) used by Astro, Next.js standalone, Nuxt, and SvelteKit. Multi-page reports group identical issues across pages.

## Scoring

| Check | Points |
| --- | ---: |
| `title` | 10 |
| `description` | 10 |
| `og:title` | 10 |
| `og:description` | 10 |
| `og:image` | 20 |
| Image loads and decodes (raster) | 15 |
| Image at least 1200x630 | 10 |
| `twitter:card` | 5 |
| Canonical link | 5 |
| No duplicate core tags | 5 |

- `90-100`: Pass
- `70-89`: Warn
- `0-69`: Fail

Folder scores are the rounded mean across scanned pages.

## Platforms

Simulates fallback chains, title/description truncation, and image size rules for:

Meta (Facebook), LinkedIn, X (Twitter), Pinterest, Slack, Discord, WhatsApp, Telegram, Bluesky, Mastodon, and iMessage.

Platform quirks to keep in mind:

- **X** requires `twitter:card` (`summary_large_image` for a large card)
- **LinkedIn** reads Open Graph tags only and caches previews for ~7 days
- **WhatsApp** prefers images under 600 KB
- **Pinterest** prefers vertical 2:3 images (~1000x1500)
- **Discord** uses `twitter:card="summary_large_image"` for a full-width embed image

## Options

| Flag | Description |
| --- | --- |
| `--json` | Print the report as JSON |
| `--fail-below <n>` | Exit 1 if the overall score is below `n` (0-100) |
| `--timeout <ms>` | Network fetch timeout in milliseconds |
| `--no-images` | Skip image loading and dimension checks |
| `--offline` | Only check local files and local path mappings; never fetch remote images |
| `--preview [file]` | Write an HTML preview report (default: `shipcard-preview.html`) |
| `--embed` | With `--preview`, inline local images as `data:` URIs |
| `--output <file>` | Write the report (JSON or plain text) to a file |
| `--watch` | Re-run when local target files change |
| `-h, --help` | Show help |
| `-V, --version` | Show version |

## Library API

```ts
import fs from "node:fs/promises";
import {
  audit,
  fixesForPage,
  applyFixes,
  renderTerminal,
  renderPreviewHtml,
} from "@otterolie/shipcard";

const report = await audit("./dist", { offline: true });
console.log(renderTerminal(report));

const page = report.pages[0];
const fixes = fixesForPage(page, report);
const html = await fs.readFile("dist/index.html", "utf8");
await fs.writeFile("dist/index.html", applyFixes(html, fixes));
```

Also exported: `auditHtml`, `auditUrl`, `auditFolder`, `extractMeta`, `scorePage`, `statusFromScore`, `validateImage`, `platformPreviews`, `fixBundle`, `summarize`, `NoHtmlFilesError`, `version`, and TypeScript report types.

## Limits

- Inspects static HTML only (does not execute JavaScript or launch a browser)
- Platform previews approximate documented rules; live feeds change frequently

## License

MIT
