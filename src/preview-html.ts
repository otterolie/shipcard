import type {
  AuditReport,
  ImageAudit,
  PageReport,
  Platform,
  PlatformField,
  PlatformPreview,
} from "./types.js";
import { fixBundle, fixesForPage, type Fix } from "./fixes.js";

/**
 * Render a self-contained HTML report with platform card mockups for every page.
 * Output is portable: open in any browser, no servers or external assets.
 *
 * Mockup styling approximates each platform's documented feed rendering. Real
 * platforms re-render constantly (viewport, locale, A/B tests, cache state), so
 * treat truncation indicators and "rendersAsLarge" as a guide, not a promise.
 */
export function renderPreviewHtml(report: AuditReport, opts: { embedLocalImages?: boolean } = {}): string {
  const target = escapeHtml(report.target.input);
  const generated = escapeHtml(formatDate(new Date(report.createdAt)));
  const targetType = report.target.type === "url" ? "URL" : "Folder";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipcard — ${target}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="doc">

  <header class="masthead">
    <div class="masthead-brand">
      <div class="wordmark">SHIPCARD</div>
      <div class="tagline">Social preview preflight</div>
    </div>
    <dl class="manifest">
      <div><dt>${targetType}</dt><dd>${target}</dd></div>
      <div><dt>Generated</dt><dd>${generated}</dd></div>
      <div><dt>Version</dt><dd>${escapeHtml(report.version)}</dd></div>
      <div><dt>Pages</dt><dd>${report.summary.pagesScanned}</dd></div>
    </dl>
    ${renderSummary(report)}
  </header>

  <main>
${report.pages.map((p, i) => renderPage(p, i + 1, report, !!opts.embedLocalImages)).join("\n")}
  </main>

  <footer class="colophon">
    <div>
      Card layouts approximate the feed rendering documented by each platform. Character limits, fallback chains, and image-size rules are based on each platform's developer docs but real rendering may vary by viewport, locale, and A/B tests.
    </div>
    <div class="colophon-mark">Shipcard ${escapeHtml(report.version)}</div>
  </footer>

</div>
</body>
</html>`;
}

function renderSummary(report: AuditReport): string {
  const { summary } = report;
  const status = summary.score >= 90 ? "ready" : summary.score >= 70 ? "warning" : "fail";
  const statusLabel =
    status === "ready" ? "Ready to ship" : status === "warning" ? "Minor leaks" : "Ship blocked";
  return `<div class="summary">
    <div class="summary-score">
      <div class="score-num">${summary.score}</div>
      <div class="score-denom">/ 100</div>
    </div>
    <div class="summary-status status-${status}">${escapeHtml(statusLabel)}</div>
    <div class="summary-tally">
      <span><strong>${summary.ready}</strong> ready</span>
      <span class="sep">·</span>
      <span><strong>${summary.warnings}</strong> warning</span>
      <span class="sep">·</span>
      <span><strong>${summary.failed}</strong> failed</span>
    </div>
  </div>`;
}

function renderPage(page: PageReport, index: number, report: AuditReport, embed = false): string {
  const hostname = hostnameFor(page);
  const num = String(index).padStart(2, "0");
  return `    <section class="page">
      <div class="page-head">
        <div class="page-num">${num}</div>
        <h2 class="page-path">${escapeHtml(page.path)}</h2>
        <div class="page-score status-${page.status}">
          <span class="page-score-num">${page.score}</span>
          <span class="page-score-denom">/100</span>
          <span class="page-status-pill">${escapeHtml(pageStatusLabel(page.status))}</span>
        </div>
      </div>
      <div class="page-cards">
${page.platforms.map((p) => renderPlatformBlock(p, page, hostname, embed)).join("\n")}
      </div>
      ${renderFixesSection(page, report)}
    </section>`;
}

function renderPlatformBlock(
  preview: PlatformPreview,
  page: PageReport,
  hostname: string,
  embed = false,
): string {
  return `        <article class="block block-${preview.platform}">
          <header class="block-head">
            <div class="block-platform">${escapeHtml(preview.label)}</div>
            <div class="block-layout">${escapeHtml(layoutLabel(preview.cardLayout))}</div>
          </header>
          <div class="block-stage">
            ${renderMockup(preview, page, hostname, embed)}
          </div>
          ${renderLedger(preview, page)}
          ${renderIssues(preview)}
        </article>`;
}

function pageStatusLabel(status: PageReport["status"]): string {
  if (status === "ready") return "Ready to ship";
  if (status === "warning") return "Minor leaks";
  return "Ship blocked";
}

// -----------------------------------------------------------------------------
// Fix-it section
// -----------------------------------------------------------------------------

function renderFixesSection(page: PageReport, report: AuditReport): string {
  const fixes = fixesForPage(page, report);
  if (fixes.length === 0) return "";

  const scorePoints = fixes.reduce((sum, f) => sum + f.weight, 0);
  const target = Math.min(100, page.score + scorePoints);
  const bundle = fixBundle(fixes);

  return `<div class="fixes">
        <header class="fixes-head">
          <h3 class="fixes-title">Get <code>${escapeHtml(page.path)}</code> to ship</h3>
          <div class="fixes-delta">
            <span class="fixes-from">${page.score}</span>
            <span class="fixes-arrow">→</span>
            <span class="fixes-to">${target}</span>
            ${scorePoints > 0 ? `<span class="fixes-points">+${scorePoints} points</span>` : ""}
          </div>
        </header>
        <ol class="fix-list">
${fixes.map((f, i) => renderFixCard(f, i + 1)).join("\n")}
        </ol>
        ${
          bundle
            ? `<details class="fix-bundle">
          <summary>All snippets as one block</summary>
          <pre class="fix-bundle-code"><code>&lt;!-- Add to &lt;head&gt; --&gt;
${escapeHtml(bundle)}</code></pre>
        </details>`
            : ""
        }
      </div>`;
}

function renderFixCard(fix: Fix, index: number): string {
  const weightLabel = fix.weight > 0 ? `+${fix.weight}` : "·";
  return `          <li class="fix">
            <div class="fix-rail">
              <span class="fix-rail-num">${String(index).padStart(2, "0")}</span>
              <span class="fix-rail-weight">${weightLabel}</span>
            </div>
            <div class="fix-body">
              <h4 class="fix-label">${escapeHtml(fix.label)}</h4>
              <p class="fix-explain">${escapeHtml(fix.explain)}</p>
              ${
                fix.snippet
                  ? `<pre class="fix-snippet"><code>${escapeHtml(fix.snippet)}</code></pre>`
                  : ""
              }
            </div>
          </li>`;
}

function layoutLabel(layout: PlatformPreview["cardLayout"]): string {
  if (layout === "large") return "Large image card";
  if (layout === "summary") return "Summary card";
  if (layout === "inline") return "Inline preview";
  return "No card — text only";
}

// -----------------------------------------------------------------------------
// Per-platform card mockups
// -----------------------------------------------------------------------------

function renderMockup(
  preview: PlatformPreview,
  page: PageReport,
  hostname: string,
  embed = false,
): string {
  if (preview.cardLayout === "none") return renderEmptyMockup(preview, hostname);

  const imgSrc = imageSrcFor(preview, page.image, embed);
  const title = preview.title.value;
  const desc = preview.description.value;

  // Use a single, consistent, simple preview renderer for all platforms.
  // This keeps the report clear, scannable, and not over-designed.
  // Platform differentiation comes from the label + layout tag (above) and any warnings (below).
  return renderSimplePreview(imgSrc, title, desc, hostname, preview.platform, preview.cardLayout);
}

function renderSimplePreview(
  img: string | null,
  title: string | null,
  desc: string | null,
  host: string,
  platform: string,
  layout: string,
): string {
  const hasImg = !!img;
  // Simple aspect control via class for the few that benefit from tall (Pinterest) or square-ish (iMessage).
  const isTall = platform === 'pinterest';
  const isSquare = platform === 'imessage';
  const imgClass = isTall ? 'preview-img-tall' : isSquare ? 'preview-img-square' : 'preview-img-standard';

  const imgHtml = hasImg
    ? `<div class="preview-img ${imgClass}">${imgEl(img)}</div>`
    : '';

  // Consistent body for all — host, title, optional desc.
  // No per-platform fancy chrome (bars, overlays, exact app colors) — clarity over mimicry.
  return `
    <div class="preview">
      ${imgHtml}
      <div class="preview-body">
        <div class="preview-host">${escapeHtml(host)}</div>
        <div class="preview-title">${renderField(title)}</div>
        ${desc ? `<div class="preview-desc">${escapeHtml(desc)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderEmptyMockup(preview: PlatformPreview, hostname: string): string {
  return `<div class="preview preview-none">
    <div class="preview-none-host">${escapeHtml(hostname)}</div>
    <div class="preview-none-note">${escapeHtml(preview.label)} will not render a rich preview for this page.</div>
  </div>`;
}

// -----------------------------------------------------------------------------
// Ledger — the per-card data block. This is the "smart" part of the report.
// -----------------------------------------------------------------------------

function renderLedger(preview: PlatformPreview, page: PageReport): string {
  const rows: string[] = [];

  rows.push(fieldRow("Title", preview.title));
  if (preview.description.charLimit !== null) {
    rows.push(fieldRow("Description", preview.description));
  }

  // Image row
  const imgRow = imageRow(preview, page.image);
  if (imgRow) rows.push(imgRow);

  return `<dl class="ledger">${rows.join("")}</dl>`;
}

function fieldRow(label: string, field: PlatformField): string {
  const source = field.source ?? "—";
  const valueLen = field.value?.length ?? 0;
  const limit = field.charLimit;
  const limitText = limit ? `${valueLen}/${limit}` : `${valueLen}`;
  const truncBadge = field.truncated
    ? `<span class="badge badge-truncated">Truncated</span>`
    : "";
  const missingBadge = !field.value
    ? `<span class="badge badge-missing">Missing</span>`
    : "";

  return `<div class="ledger-row">
    <dt>${label}</dt>
    <dd>
      <span class="ledger-source">from <code>${escapeHtml(source)}</code></span>
      <span class="ledger-count">${limitText} chars</span>
      ${truncBadge}${missingBadge}
    </dd>
  </div>`;
}

function imageRow(preview: PlatformPreview, image: ImageAudit | null): string {
  if (!preview.image.url && !image) return "";
  const source = preview.image.source ?? "—";
  const dims =
    image && image.width && image.height ? `${image.width}×${image.height}` : "unknown";
  const layoutNote = preview.image.rendersAsLarge
    ? `<span class="badge badge-ok">Large layout</span>`
    : preview.image.url
      ? `<span class="badge badge-warn">Small layout</span>`
      : `<span class="badge badge-missing">No image</span>`;
  return `<div class="ledger-row">
    <dt>Image</dt>
    <dd>
      <span class="ledger-source">from <code>${escapeHtml(source)}</code></span>
      <span class="ledger-count">${escapeHtml(dims)}</span>
      ${layoutNote}
    </dd>
  </div>`;
}

function renderIssues(preview: PlatformPreview): string {
  if (preview.warnings.length === 0) {
    return `<div class="issues issues-clean">No platform-specific warnings.</div>`;
  }
  const sorted = [...preview.warnings].sort(
    (a, b) =>
      (a.severity === "error" ? 0 : a.severity === "warning" ? 1 : 2) -
      (b.severity === "error" ? 0 : b.severity === "warning" ? 1 : 2),
  );
  return `<ul class="issues">
${sorted
  .map(
    (w) =>
      `    <li class="issue issue-${w.severity}"><span class="issue-mark"></span>${escapeHtml(w.message)}</li>`,
  )
  .join("\n")}
  </ul>`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function renderField(value: string | null): string {
  if (!value) return `<span class="placeholder">No title</span>`;
  return escapeHtml(value);
}

function imgEl(src: string): string {
  return `<img src="${escapeAttr(src)}" alt="" loading="lazy">`;
}

function imageSrcFor(preview: PlatformPreview, audit: ImageAudit | null, embed: boolean): string | null {
  if (!preview.image.url) return null;
  if (audit) return absoluteSrc(audit.resolvedSource, embed, audit);
  return absoluteSrc(preview.image.url, embed);
}

function absoluteSrc(value: string, embed = false, audit?: ImageAudit | null): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("data:")) return value;
  if (embed && audit && (audit as any).buffer) {
    const b = (audit as any).buffer as Buffer;
    const ct = audit.contentType || "image/png";
    return `data:${ct};base64,${b.toString("base64")}`;
  }
  if (embed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith("data:")) {
    // Try to read local file at render time for embed (works for both resolved fs paths and relative)
    try {
      const fs = require("node:fs");
      const p = value.startsWith("/") ? value : value; // resolvedSource is usually absolute for folder
      if (fs.existsSync(p)) {
        const b = fs.readFileSync(p);
        // best effort content type
        const ct = (audit && audit.contentType) || "image/png";
        return `data:${ct};base64,${b.toString("base64")}`;
      }
    } catch {}
  }
  if (value.startsWith("/")) return `file://${value}`;
  return value;
}

function hostnameFor(page: PageReport): string {
  const candidate = page.meta.canonical || page.meta.url;
  if (candidate) {
    try {
      return new URL(candidate).hostname.replace(/^www\./, "");
    } catch {
      // candidate wasn't a valid URL; fall back below
    }
  }
  if (/^https?:\/\//i.test(page.source)) {
    try {
      return new URL(page.source).hostname.replace(/^www\./, "");
    } catch {
      return page.source;
    }
  }
  return "your-site.com";
}

function formatDate(d: Date): string {
  const date = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} at ${time}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// -----------------------------------------------------------------------------
// Styles — self-contained, hand-tuned. Publication aesthetic, not dashboard.
// -----------------------------------------------------------------------------

const STYLES = `
:root { --bg:#fff; --text:#111; --muted:#555; --border:#e5e5e5; --accent:#0a66c2; --ready:#0a7d3e; --warn:#b36b00; --fail:#b71c1c; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono","Courier New",monospace; --sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
* { box-sizing:border-box; }
html,body { margin:0;padding:0; }
body { font:14px/1.45 var(--sans); color:var(--text); background:var(--bg); }
.doc { max-width:1100px; margin:0 auto; padding:28px 20px; }
.masthead { border-bottom:2px solid var(--text); padding-bottom:16px; margin-bottom:24px; }
.masthead-brand { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
.wordmark { font-weight:700; font-size:18px; letter-spacing:.5px; }
.tagline { font-size:13px; color:var(--muted); }
.manifest { display:flex; flex-wrap:wrap; gap:8px 16px; font-size:11px; color:var(--muted); }
.summary { display:flex; align-items:baseline; gap:12px; margin-bottom:24px; }
.score-num { font-size:48px; font-weight:600; line-height:1; }
.page { margin-bottom:36px; }
.page-head { display:flex; align-items:center; gap:8px; padding-bottom:6px; margin-bottom:12px; border-bottom:1px solid var(--border); }
.page-num { font-family:var(--mono); font-size:16px; color:var(--muted); width:28px; }
.page-path { font-family:var(--mono); font-size:12px; flex:1; word-break:break-all; margin:0; }
.page-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
.block { border:1px solid var(--border); }
.block-head { display:flex; justify-content:space-between; padding:6px 10px; background:#f7f7f7; border-bottom:1px solid var(--border); font-size:10px; }
.block-platform { font-weight:600; text-transform:uppercase; letter-spacing:.5px; }
.block-layout { color:var(--muted); }
.block-stage { padding:12px; background:#fafafa; min-height:140px; display:flex; align-items:center; justify-content:center; }
.preview { width:100%; max-width:320px; border:1px solid #ddd; background:#fff; overflow:hidden; font-size:12px; }
.preview-body { padding:6px 8px; }
.preview-host { font-size:9px; color:#666; text-transform:uppercase; letter-spacing:.5px; margin-bottom:1px; }
.preview-title { font-weight:600; line-height:1.25; }
.preview-desc { color:#444; font-size:11px; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.preview-img { background:#f0f0f0; overflow:hidden; }
.preview-img img { width:100%; height:100%; object-fit:cover; display:block; }
.preview-img-standard { aspect-ratio:1.91/1; }
.preview-img-tall { aspect-ratio:2/3; }
.preview-img-square { aspect-ratio:1/1; }
.preview-none { padding:12px; border:1px dashed #ccc; text-align:center; font-size:11px; color:#666; }
.ledger { margin:0; padding:6px 10px; border-top:1px solid var(--border); font-size:10px; background:#fff; }
.ledger-row { display:grid; grid-template-columns:64px 1fr; gap:6px; padding:2px 0; }
.ledger-row + .ledger-row { border-top:1px dotted #e5e5e5; }
.ledger dt { font-weight:600; color:#555; }
.ledger dd { margin:0; }
.badge { font-size:8px; padding:0 4px; border:1px solid currentColor; border-radius:1px; text-transform:uppercase; }
.issues { list-style:none; margin:0; padding:6px 10px; border-top:1px solid var(--border); font-size:11px; }
.issues-clean { color:var(--ready); font-style:italic; }
.issue { padding-left:12px; position:relative; }
.issue-mark { position:absolute; left:0; top:5px; width:4px; height:4px; border-radius:50%; background:currentColor; }
.fixes { margin-top:12px; padding-top:8px; border-top:1px solid var(--border); }
.fixes-head { display:flex; gap:8px; align-items:baseline; margin-bottom:6px; font-size:12px; font-weight:600; }
.fix-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.fix { display:grid; grid-template-columns:42px 1fr; gap:6px; padding:6px 8px; border:1px solid var(--border); font-size:11px; }
.fix-snippet { margin-top:4px; padding:4px 6px; background:#111; color:#eee; font-family:var(--mono); font-size:10px; white-space:pre; overflow:auto; }
.colophon { margin-top:36px; padding-top:12px; border-top:1px solid var(--border); font-size:10px; color:#666; }
@media (max-width:640px){ .doc{padding:16px 12px;} .page-cards{grid-template-columns:1fr;} }
`;

