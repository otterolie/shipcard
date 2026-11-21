import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AuditReport,
  ImageAudit,
  PageReport,
  PageStatus,
  PlatformField,
  PlatformPreview,
} from "./types.js";
import { fixBundle, fixesForPage, type Fix } from "./fixes.js";
import { statusFromScore } from "./score.js";
import { escapeHtml } from "./utils.js";

const TARGET_TYPE_LABELS: Record<AuditReport["target"]["type"], string> = {
  url: "URL",
  folder: "Folder",
  file: "File",
  stdin: "Stdin",
};

const STATUS_LABELS: Record<PageStatus, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

/** Render a self-contained HTML preview report with platform mockups and fix snippets. */
export function renderPreviewHtml(
  report: AuditReport,
  opts: { embedLocalImages?: boolean } = {},
): string {
  const target = escapeHtml(report.target.input);
  const generated = escapeHtml(formatDate(new Date(report.createdAt)));
  const targetType = TARGET_TYPE_LABELS[report.target.type];
  const overall = statusFromScore(report.summary.score);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shipcard: ${target}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="container">
  <header class="header">
    <div class="header-top">
      <div>
        <h1 class="title">shipcard</h1>
        <p class="meta-line">
          <span>${targetType}: <code>${target}</code></span>
          <span>Pages: ${report.summary.pagesScanned}</span>
          <span>Generated: ${generated}</span>
          <span>v${escapeHtml(report.version)}</span>
        </p>
      </div>
      <div class="summary">
        <div class="score-badge status-${overall}">
          <span class="score-value">${report.summary.score}</span><span class="score-max">/100</span>
          <span class="status-pill">${STATUS_LABELS[overall]}</span>
        </div>
        <div class="tally">
          <span><strong>${report.summary.passed}</strong> pass</span>
          <span><strong>${report.summary.warnings}</strong> warn</span>
          <span><strong>${report.summary.failed}</strong> fail</span>
        </div>
      </div>
    </div>
  </header>

  <main>
${report.pages.map((p, i) => renderPage(p, i + 1, report, !!opts.embedLocalImages)).join("\n")}
  </main>

  <footer class="footer">
    Previews approximate each platform's documented link-card rules. Actual feeds vary by viewport, locale, and cache state.
  </footer>
</div>
</body>
</html>`;
}

function renderPage(page: PageReport, index: number, report: AuditReport, embed: boolean): string {
  const hostname = hostnameFor(page);
  return `    <section class="page">
      <div class="page-head">
        <span class="page-index">${String(index).padStart(2, "0")}</span>
        <h2 class="page-path">${escapeHtml(page.path)}</h2>
        <span class="page-score status-${page.status}">
          ${page.score}/100 · ${STATUS_LABELS[page.status]}
        </span>
      </div>
      <div class="cards-grid">
${page.platforms.map((p) => renderPlatformCard(p, page, hostname, embed)).join("\n")}
      </div>
      ${renderFixesSection(page, report)}
    </section>`;
}

function renderPlatformCard(
  preview: PlatformPreview,
  page: PageReport,
  hostname: string,
  embed: boolean,
): string {
  const audit = auditForPlatform(preview, page);
  return `        <article class="card">
          <header class="card-head">
            <span class="card-platform">${escapeHtml(preview.label)}</span>
            <span class="card-layout">${escapeHtml(layoutLabel(preview.cardLayout))}</span>
          </header>
          <div class="card-stage">
            ${renderMockup(preview, audit, hostname, embed)}
          </div>
          ${renderDetails(preview, audit)}
          ${renderIssues(preview)}
        </article>`;
}

function auditForPlatform(preview: PlatformPreview, page: PageReport): ImageAudit | null {
  if (!preview.image.url) return null;
  if (page.images && page.images.length > 0) {
    const exact = page.images.find((i) => i.source === preview.image.url);
    if (exact) return exact;
  }
  return page.image;
}

function renderFixesSection(page: PageReport, report: AuditReport): string {
  const fixes = fixesForPage(page, report);
  if (fixes.length === 0) return "";

  const scorePoints = fixes.reduce((sum, f) => sum + f.weight, 0);
  const target = Math.min(100, page.score + scorePoints);
  const bundle = fixBundle(fixes);

  return `<div class="fixes">
        <div class="fixes-head">
          <h3>Fixes for <code>${escapeHtml(page.path)}</code></h3>
          <span class="fixes-delta">${page.score} → ${target}${scorePoints > 0 ? ` (+${scorePoints})` : ""}</span>
        </div>
        <ol class="fix-list">
${fixes.map((f, i) => renderFixItem(f, i + 1)).join("\n")}
        </ol>
        ${
          bundle
            ? `<details class="fix-bundle">
          <summary>Copy all snippets</summary>
          <pre class="code-block"><code>${escapeHtml(bundle)}</code></pre>
        </details>`
            : ""
        }
      </div>`;
}

function renderFixItem(fix: Fix, index: number): string {
  const weight = fix.weight > 0 ? `+${fix.weight}` : "·";
  return `          <li class="fix-item">
            <div class="fix-meta">
              <span class="fix-num">${String(index).padStart(2, "0")}</span>
              <span class="fix-weight">${weight}</span>
            </div>
            <div class="fix-body">
              <div class="fix-label">${escapeHtml(fix.label)}</div>
              <p class="fix-explain">${escapeHtml(fix.explain)}</p>
              ${fix.snippet ? `<pre class="code-block"><code>${escapeHtml(fix.snippet)}</code></pre>` : ""}
            </div>
          </li>`;
}

function layoutLabel(layout: PlatformPreview["cardLayout"]): string {
  if (layout === "large") return "Large image";
  if (layout === "summary") return "Summary";
  if (layout === "inline") return "Inline";
  return "Text only";
}

function renderMockup(
  preview: PlatformPreview,
  audit: ImageAudit | null,
  hostname: string,
  embed: boolean,
): string {
  if (preview.cardLayout === "none") {
    return `<div class="mockup mockup-none">
      <div class="mockup-host">${escapeHtml(hostname)}</div>
      <div class="mockup-empty">${escapeHtml(preview.label)} will not render a rich preview.</div>
    </div>`;
  }

  const imgSrc = imageSrcFor(preview, audit, embed);
  const title = preview.title.value;
  const desc = preview.description.value;
  const isTall = preview.platform === "pinterest";
  const isSquare = preview.platform === "imessage" || preview.cardLayout === "summary";
  const imgRatio = isTall ? "ratio-tall" : isSquare ? "ratio-square" : "ratio-wide";

  const layoutClass =
    preview.cardLayout === "summary"
      ? "mockup-summary"
      : preview.cardLayout === "inline"
        ? "mockup-inline"
        : "mockup-large";

  const imgHtml = imgSrc
    ? `<div class="mockup-img ${imgRatio}"><img src="${escapeHtml(imgSrc)}" alt="" loading="lazy"></div>`
    : "";

  return `<div class="mockup ${layoutClass}">
    ${imgHtml}
    <div class="mockup-body">
      <div class="mockup-host">${escapeHtml(hostname)}</div>
      <div class="mockup-title">${title ? escapeHtml(title) : '<span class="muted">No title</span>'}</div>
      ${desc ? `<div class="mockup-desc">${escapeHtml(desc)}</div>` : ""}
    </div>
  </div>`;
}

function renderDetails(preview: PlatformPreview, audit: ImageAudit | null): string {
  const rows: string[] = [fieldRow("Title", preview.title)];
  if (preview.description.charLimit !== null) {
    rows.push(fieldRow("Description", preview.description));
  }
  const imgRow = imageRow(preview, audit);
  if (imgRow) rows.push(imgRow);
  return `<dl class="details">${rows.join("")}</dl>`;
}

function fieldRow(label: string, field: PlatformField): string {
  const source = field.source ?? "—";
  const len = field.value?.length ?? 0;
  const count = field.charLimit ? `${len}/${field.charLimit}` : `${len}`;
  const badge = !field.value
    ? '<span class="badge badge-fail">Missing</span>'
    : field.truncated
      ? '<span class="badge badge-warn">Truncated</span>'
      : "";

  return `<div class="detail-row">
    <dt>${label}</dt>
    <dd><code>${escapeHtml(source)}</code> <span class="muted">${count} chars</span> ${badge}</dd>
  </div>`;
}

function imageRow(preview: PlatformPreview, audit: ImageAudit | null): string {
  if (!preview.image.url && !audit) return "";
  const source = preview.image.source ?? "—";
  const dims = audit && audit.width && audit.height ? `${audit.width}x${audit.height}` : "unknown";
  const badge = preview.image.rendersAsLarge
    ? '<span class="badge badge-pass">Large</span>'
    : preview.image.url && preview.image.meetsMinimum
      ? '<span class="badge badge-warn">Small</span>'
      : '<span class="badge badge-fail">Unavailable</span>';

  return `<div class="detail-row">
    <dt>Image</dt>
    <dd><code>${escapeHtml(source)}</code> <span class="muted">${escapeHtml(dims)}</span> ${badge}</dd>
  </div>`;
}

function renderIssues(preview: PlatformPreview): string {
  if (preview.warnings.length === 0) {
    return `<div class="issues issues-clean">No platform warnings.</div>`;
  }
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...preview.warnings].sort((a, b) => order[a.severity] - order[b.severity]);
  return `<ul class="issues">
${sorted.map((w) => `    <li class="issue issue-${w.severity}">${escapeHtml(w.message)}</li>`).join("\n")}
  </ul>`;
}

function imageSrcFor(
  preview: PlatformPreview,
  audit: ImageAudit | null,
  embed: boolean,
): string | null {
  if (!preview.image.url) return null;
  if (audit) return toImgSrc(audit.resolvedSource, embed, audit.contentType);
  return toImgSrc(preview.image.url, embed, null);
}

function toImgSrc(value: string, embed: boolean, contentType: string | null): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("data:")) return value;

  if (embed) {
    try {
      if (fs.existsSync(value) && fs.statSync(value).isFile()) {
        const buf = fs.readFileSync(value);
        const ct = contentType || guessContentType(value) || "image/png";
        return `data:${ct};base64,${buf.toString("base64")}`;
      }
    } catch {
      // fall through
    }
  }

  if (path.isAbsolute(value)) return pathToFileURL(value).href;
  return value;
}

function guessContentType(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  return null;
}

function hostnameFor(page: PageReport): string {
  for (const candidate of [page.meta.canonical, page.meta.url, page.source]) {
    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
    try {
      return new URL(candidate).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
  }
  return "your-site.com";
}

function formatDate(d: Date): string {
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STYLES = `
:root {
  --bg: #ffffff;
  --surface: #f8f9fa;
  --text: #18181b;
  --muted: #64748b;
  --border: #e2e8f0;
  --pass: #15803d;
  --pass-bg: #dcfce7;
  --warn: #a16207;
  --warn-bg: #fef9c3;
  --fail: #b91c1c;
  --fail-bg: #fee2e2;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font: 14px/1.5 var(--sans); color: var(--text); background: var(--bg); }
code { font-family: var(--mono); font-size: 0.9em; }
.muted { color: var(--muted); }
.container { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }

.header { border-bottom: 1px solid var(--border); padding-bottom: 18px; margin-bottom: 28px; }
.header-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 16px; }
.title { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.meta-line { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); }

.summary { text-align: right; }
.score-badge { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); }
.score-value { font-size: 28px; font-weight: 700; line-height: 1; }
.score-max { font-size: 13px; color: var(--muted); }
.status-pill { font-size: 12px; font-weight: 600; margin-left: 4px; }
.status-pass { color: var(--pass); background: var(--pass-bg); border-color: #bbf7d0; }
.status-warn { color: var(--warn); background: var(--warn-bg); border-color: #fde68a; }
.status-fail { color: var(--fail); background: var(--fail-bg); border-color: #fecaca; }
.tally { margin-top: 6px; display: flex; justify-content: flex-end; gap: 12px; font-size: 12px; color: var(--muted); }
.tally strong { color: var(--text); }

.page { margin-bottom: 36px; }
.page-head { display: flex; align-items: center; gap: 10px; padding-bottom: 8px; margin-bottom: 14px; border-bottom: 1px solid var(--border); }
.page-index { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.page-path { margin: 0; font-family: var(--mono); font-size: 13px; font-weight: 600; flex: 1; word-break: break-all; }
.page-score { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }

.cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
.card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; background: var(--bg); }
.card-head { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--border); font-size: 12px; }
.card-platform { font-weight: 600; }
.card-layout { color: var(--muted); font-size: 11px; }
.card-stage { padding: 14px; background: #f1f5f9; min-height: 130px; display: flex; align-items: center; justify-content: center; flex: 1; }

.mockup { width: 100%; max-width: 320px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; overflow: hidden; font-size: 12px; }
.mockup-summary { display: grid; grid-template-columns: 84px 1fr; align-items: stretch; }
.mockup-inline { border-left: 3px solid #64748b; display: flex; flex-direction: row-reverse; align-items: center; gap: 10px; padding: 8px 10px; }
.mockup-inline .mockup-img { width: 56px; height: 56px; border-radius: 4px; flex-shrink: 0; }
.mockup-inline .mockup-body { padding: 0; flex: 1; min-width: 0; }
.mockup-body { padding: 8px 10px; min-width: 0; }
.mockup-host { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mockup-title { font-weight: 600; line-height: 1.3; margin-bottom: 2px; word-break: break-word; }
.mockup-desc { color: #475569; font-size: 11px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mockup-img { background: #e2e8f0; overflow: hidden; }
.mockup-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ratio-wide { aspect-ratio: 1.91 / 1; }
.ratio-tall { aspect-ratio: 2 / 3; max-height: 220px; }
.ratio-square { aspect-ratio: 1 / 1; }
.mockup-none { padding: 16px; border: 1px dashed #cbd5e1; text-align: center; color: var(--muted); font-size: 12px; }
.mockup-empty { margin-top: 4px; }

.details { margin: 0; padding: 8px 12px; border-top: 1px solid var(--border); font-size: 11px; }
.detail-row { display: grid; grid-template-columns: 74px 1fr; gap: 6px; padding: 3px 0; align-items: baseline; }
.detail-row + .detail-row { border-top: 1px solid #f1f5f9; }
.details dt { font-weight: 600; color: var(--muted); }
.details dd { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }

.badge { font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 3px; line-height: 1.6; }
.badge-pass { color: var(--pass); background: var(--pass-bg); }
.badge-warn { color: var(--warn); background: var(--warn-bg); }
.badge-fail { color: var(--fail); background: var(--fail-bg); }

.issues { list-style: none; margin: 0; padding: 8px 12px; border-top: 1px solid var(--border); font-size: 11px; display: flex; flex-direction: column; gap: 4px; }
.issues-clean { color: var(--pass); }
.issue { padding-left: 12px; position: relative; }
.issue::before { content: ""; position: absolute; left: 0; top: 6px; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.issue-error { color: var(--fail); }
.issue-warning { color: var(--warn); }
.issue-info { color: var(--muted); }

.fixes { margin-top: 16px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.fixes-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.fixes-head h3 { margin: 0; font-size: 14px; }
.fixes-delta { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.fix-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.fix-item { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); font-size: 12px; }
.fix-meta { font-family: var(--mono); font-size: 11px; color: var(--muted); display: flex; gap: 6px; }
.fix-weight { color: var(--pass); font-weight: 600; }
.fix-label { font-weight: 600; margin-bottom: 2px; }
.fix-explain { margin: 0; color: var(--muted); font-size: 12px; }
.code-block { margin: 6px 0 0; padding: 8px 10px; background: #0f172a; color: #e2e8f0; border-radius: 5px; font-family: var(--mono); font-size: 11px; overflow-x: auto; white-space: pre; }
.fix-bundle { margin-top: 10px; font-size: 12px; }
.fix-bundle summary { cursor: pointer; font-weight: 600; color: var(--text); }

.footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }

@media (max-width: 640px) {
  .container { padding: 16px 12px 32px; }
  .summary { text-align: left; }
  .tally { justify-content: flex-start; }
  .cards-grid { grid-template-columns: 1fr; }
}
`;
