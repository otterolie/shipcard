# shipcard

Checks your Open Graph, Twitter, and social link preview tags before you ship. Point it at a build folder (`./dist`), a single `.html` file, stdin (`-`), a live URL, or an XML sitemap.

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
npx @otterolie/shipcard ./dist --offline --ignore 404.html

# Audit a running dev server or deployed page
npx @otterolie/shipcard http://localhost:3000

# Audit a deployed site from its sitemap
npx @otterolie/shipcard https://example.com/sitemap.xml --failures-only

# Audit a single HTML file or stdin
npx @otterolie/shipcard ./dist/index.html
cat dist/index.html | npx @otterolie/shipcard -

# CI gate and JSON output
npx @otterolie/shipcard ./dist --offline --fail-below 85
npx @otterolie/shipcard ./dist --offline --fail-on fail
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
- Missing, undecodable, SVG, AVIF, data-URI, undersized (`< 1200x630`), off-aspect-ratio (outside `1.4:1–2.3:1`), or oversized (`> 5 MB`) images
- Mismatches between declared `og:image:width`/`height` and actual image dimensions
- Missing images that exist under another subfolder (common when scanning the wrong build directory)
- Social meta tags appearing late in the HTML (`> 50 KB` into the document, past common crawler byte limits)
- Duplicate core meta tags on a page, and identical titles or descriptions shared across multiple pages

Folder scans auto-detect standard build directories (`dist`, `out`, `build`, `public`, `.output`, `export`) when run from a repo root, auto-descend into split client/server output directories (`client`, `public`, `static`, `www`), skip `<meta http-equiv="refresh">` redirect stubs by default, and group identical issues across pages.

## Scoring

| Check | Points |
| --- | ---: |
| `og:title` (partial credit if only `<title>` exists) | 15 |
| `og:description` (partial credit if only meta description exists) | 10 |
| `og:image` present | 15 |
| Image loads as PNG, JPEG, or WebP (partial credit for AVIF) | 15 |
| Image at least 1200x630 | 10 |
| Image aspect ratio near 1.91:1 | 5 |
| Production-ready `https://` URLs (no localhost, relative, `http://`, or `data:`) | 15 |
| Valid `twitter:card` value | 5 |
| Canonical link | 5 |
| No duplicate core tags | 5 |

- Skipped checks (with `--no-images` or remote images skipped under `--offline`) are excluded from the denominator rather than counted as failures.
- Any error-level issue (for example a broken `twitter:image`) caps the page status at `Warn` regardless of score.
- `90-100`: Pass · `70-89`: Warn · `0-69`: Fail
- Multi-page reports include both the mean `score` and the worst page's `minScore`. Use `--fail-on fail` (or `--fail-on warn`) in CI so one broken page is not hidden by a high average.

## Platforms

Simulates fallback chains, title/description truncation, and image size rules for:

Meta (Facebook / IG), LinkedIn, X (Twitter), Pinterest, Slack, Discord, WhatsApp, Telegram, Bluesky, Mastodon, and iMessage.

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
| `--fail-on <warn\|fail>` | Exit 1 if any page has status `warn` or `fail` |
| `--timeout <ms>` | Network fetch timeout in milliseconds |
| `--no-images` | Skip image loading and dimension checks |
| `--offline` | Only check local files and local path mappings; never fetch remote images |
| `--ignore <pattern>` | Skip matching paths or basenames (repeatable, e.g. `--ignore 404.html --ignore "/admin/**"`) |
| `--include-redirects` | Include `<meta http-equiv="refresh">` redirect stubs in multi-page audits |
| `--failures-only` | Hide passing pages in multi-page terminal output |
| `--sitemap` | Treat a URL target as an XML sitemap even if it does not end in `.xml` |
| `--max-pages <n>` | Maximum pages to audit from a sitemap (default: `50`) |
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

const report = await audit("./dist", {
  offline: true,
  ignore: ["404.html", "/admin/**"],
});
console.log(renderTerminal(report, { failuresOnly: true }));

const page = report.pages[0];
const fixes = fixesForPage(page, report);
const html = await fs.readFile("dist/index.html", "utf8");
await fs.writeFile("dist/index.html", applyFixes(html, fixes));
```

Also exported: `auditHtml`, `auditUrl`, `auditFolder`, `auditSitemap`, `parseSitemapXml`, `extractMeta`, `extractMetaWithStats`, `scorePage`, `statusFromScore`, `validateImage`, `platformPreviews`, `fixBundle`, `summarize`, `NoHtmlFilesError`, `version`, and TypeScript report types.

## Limits

- Inspects static HTML only (does not execute JavaScript or launch a browser)
- Platform previews approximate documented rules; live feeds change frequently

## License

MIT
