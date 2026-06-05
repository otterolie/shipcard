import pc from "picocolors";
import type { AuditReport, CardLayout, PageReport, PageStatus, PlatformPreview, Warning } from "./types.js";
import { formatBytes } from "./utils.js";
import { statusFromScore } from "./score.js";
import { fixesForPage, type Fix } from "./fixes.js";

const SEVERITY_ORDER: Record<Warning["severity"], number> = { error: 0, warning: 1, info: 2 };

const STATUS_PAINT: Record<PageStatus, { icon: string; label: string; line: string }> = {
  ready:   { icon: pc.green("✓"),  label: pc.green("Ready to ship"),   line: pc.green("Ready to ship") },
  warning: { icon: pc.yellow("⚠"), label: pc.yellow("Minor leaks"),    line: pc.yellow("Minor leaks found") },
  fail:    { icon: pc.red("✕"),    label: pc.red("Ship blocked"),      line: pc.red("Ship blocked") },
};

/** Render an AuditReport as a terminal-friendly string. */
export function renderTerminal(report: AuditReport): string {
  const lines = [pc.bold(pc.cyan("Shipcard")), "", `Target: ${report.target.input}`];
  return report.target.type === "folder"
    ? renderFolder(report, lines)
    : renderSingle(report, lines);
}

function renderFolder(report: AuditReport, lines: string[]): string {
  const fleetStatus = statusFromScore(report.summary.score);
  lines.push(`Pages scanned: ${report.summary.pagesScanned}`);
  lines.push(`Fleet score: ${report.summary.score}/100`);
  lines.push(`Status: ${STATUS_PAINT[fleetStatus].line}`);
  lines.push("");
  lines.push(pc.bold("Pages:"));

  const pathWidth = Math.min(40, Math.max(12, ...report.pages.map((p) => p.path.length)));

  for (const page of report.pages) {
    const { icon, label } = STATUS_PAINT[page.status];
    const path = page.path.padEnd(pathWidth);
    const score = String(page.score).padEnd(4);
    lines.push(`${icon} ${path}  ${score}  ${label}`);
  }

  for (const page of report.pages) {
    if (page.status === "ready") continue;
    lines.push("");
    lines.push(pc.bold(page.path));
    if (page.warnings.length > 0) {
      lines.push(pc.dim("Leaks:"));
      for (const w of sortWarnings(page.warnings)) {
        lines.push(`  ${severityBullet(w)}${w.message}`);
      }
    }
    appendFixHint(lines, page, report);
  }

  lines.push("");
  return lines.join("\n");
}

function renderSingle(report: AuditReport, lines: string[]): string {
  const page = report.pages[0];
  if (!page) return [...lines, pc.red("No page audited.")].join("\n");

  lines.push(`Score: ${page.score}/100`);
  lines.push(`Status: ${STATUS_PAINT[page.status].line}`);
  lines.push("");
  lines.push(pc.bold("Deck check:"));
  for (const c of page.checks) {
    const mark = c.passed ? pc.green("✓") : pc.red("✕");
    lines.push(`  ${mark} ${c.label} ${pc.dim(`(${c.weight})`)}`);
  }

  lines.push("", pc.bold("Metadata:"));
  lines.push(formatField("title", page.meta.title));
  lines.push(formatField("description", page.meta.description));
  lines.push(formatField("og:image", page.meta.image));
  lines.push(formatField("og:url", page.meta.url));
  lines.push(formatField("canonical", page.meta.canonical));
  lines.push(formatField("twitter:card", page.meta.twitterCard));

  if (page.image) {
    lines.push("", pc.bold("Image:"));
    lines.push(`  Source: ${page.image.resolvedSource}`);
    if (page.image.width && page.image.height) {
      lines.push(`  Dimensions: ${page.image.width}x${page.image.height}`);
    }
    if (page.image.sizeBytes !== null) lines.push(`  Size: ${formatBytes(page.image.sizeBytes)}`);
    if (page.image.contentType) lines.push(`  Content type: ${page.image.contentType}`);
  }

  if (page.warnings.length > 0) {
    lines.push("", pc.bold("Leaks:"));
    for (const w of sortWarnings(page.warnings)) {
      lines.push(`  ${severityBullet(w)}${w.message}`);
    }
  }

  if (page.status !== "ready") {
    appendFixHint(lines, page, report);
  }

  if (page.platforms.length > 0) {
    lines.push("", pc.bold("Platform previews:"));
    for (const line of renderPlatformTable(page.platforms)) lines.push("  " + line);
  }

  lines.push("");
  return lines.join("\n");
}

const CARD_LAYOUT_LABELS: Record<CardLayout, string> = {
  large: "Large image card",
  summary: "Summary card",
  inline: "Inline preview",
  none: "Text only",
};

function renderPlatformTable(platforms: PlatformPreview[]): string[] {
  const labelWidth = Math.max(...platforms.map((p) => p.label.length));
  const layoutWidth = Math.max(...platforms.map((p) => CARD_LAYOUT_LABELS[p.cardLayout].length));

  return platforms.map((p) => {
    const errors = p.warnings.filter((w) => w.severity === "error").length;
    const warns = p.warnings.filter((w) => w.severity === "warning").length;
    const icon =
      errors > 0 ? pc.red("✕") : warns > 0 ? pc.yellow("⚠") : pc.green("✓");
    const label = p.label.padEnd(labelWidth);
    const layout = CARD_LAYOUT_LABELS[p.cardLayout].padEnd(layoutWidth);
    const truncated = [p.title, p.description].filter((f) => f.truncated).length;
    const truncatedNote = truncated > 0 ? pc.dim(` (${truncated} truncated)`) : "";
    return `${icon} ${label}  ${pc.dim("→")} ${layout}${truncatedNote}`;
  });
}

function formatField(label: string, value: string | null): string {
  return value === null ? `  ${label}: ${pc.dim("(missing)")}` : `  ${label}: ${value}`;
}

function severityBullet(w: Warning): string {
  if (w.severity === "error") return pc.red("• ");
  if (w.severity === "warning") return pc.yellow("• ");
  return pc.dim("• ");
}

function sortWarnings(warnings: Warning[]): Warning[] {
  // Stable sort: errors first, warnings, then info. Preserves emit order within a severity.
  return [...warnings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function appendFixHint(lines: string[], page: PageReport, report: AuditReport): void {
  const fixes = fixesForPage(page, report);
  if (fixes.length === 0) return;
  const points = fixes.reduce((s, f) => s + f.weight, 0);
  const target = Math.min(100, page.score + points);
  const headline =
    points > 0
      ? `Fix it: ${page.score} → ${target} (+${points})`
      : "Fix it (quality improvements):";
  lines.push(pc.dim(headline));
  const labelWidth = Math.max(...fixes.map((f) => f.label.length));
  for (const fix of fixes) {
    const weight = fix.weight > 0 ? pc.cyan(`+${String(fix.weight).padStart(2)}`) : pc.dim(" · ");
    lines.push(`  ${weight}  ${fix.label.padEnd(labelWidth)}  ${snippetPreview(fix)}`);
  }
}

function snippetPreview(fix: Fix): string {
  if (!fix.snippet) return pc.dim("(see --preview for details)");
  const max = 70;
  const single = fix.snippet.replace(/\s+/g, " ").trim();
  const trimmed = single.length > max ? single.slice(0, max - 1) + "…" : single;
  return pc.dim(trimmed);
}
