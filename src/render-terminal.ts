import * as ansi from "./ansi.js";
import type {
  AuditReport,
  CardLayout,
  PageReport,
  PageStatus,
  PlatformPreview,
  Warning,
} from "./types.js";
import { formatBytes } from "./utils.js";
import { statusFromScore } from "./score.js";
import { fixesForPage, type Fix } from "./fixes.js";

const SEVERITY_ORDER: Record<Warning["severity"], number> = { error: 0, warning: 1, info: 2 };

function statusPaint(status: PageStatus): { icon: string; label: string } {
  if (status === "pass") return { icon: ansi.green("✓"), label: ansi.green("Pass") };
  if (status === "warn") return { icon: ansi.yellow("⚠"), label: ansi.yellow("Warn") };
  return { icon: ansi.red("✕"), label: ansi.red("Fail") };
}

const CARD_LAYOUT_LABELS: Record<CardLayout, string> = {
  large: "Large image card",
  summary: "Summary card",
  inline: "Inline preview",
  none: "Text only",
};

export type RenderTerminalOptions = {
  color?: boolean;
  /** Hide passing pages from the multi-page summary table. */
  failuresOnly?: boolean;
};

/** Render an AuditReport for terminal output. Pass `{ color: false }` for plain text files. */
export function renderTerminal(report: AuditReport, options: RenderTerminalOptions = {}): string {
  const lines = [ansi.bold(ansi.cyan("shipcard")), "", `Target: ${report.target.input}`];
  const isMulti = report.target.type === "folder" || report.target.type === "sitemap";
  const output = isMulti
    ? renderMulti(report, lines, !!options.failuresOnly)
    : renderSingle(report, lines);
  return options.color === false ? ansi.stripAnsi(output) : output;
}

function renderMulti(report: AuditReport, lines: string[], failuresOnly: boolean): string {
  const overall = statusFromScore(report.summary.score);
  const tally = [
    `${report.summary.passed} pass`,
    `${report.summary.warnings} warn`,
    `${report.summary.failed} fail`,
  ];
  if (report.summary.skipped) tally.push(`${report.summary.skipped} skipped`);

  lines.push(`Pages: ${report.summary.pagesScanned} (${tally.join(", ")})`);
  if (report.summary.pagesScanned > 0) {
    const minNote =
      report.summary.pagesScanned >= 2 && report.summary.minScore !== report.summary.score
        ? ansi.dim(` (min ${report.summary.minScore})`)
        : "";
    lines.push(`Score: ${report.summary.score}/100${minNote} (${statusPaint(overall).label})`);
  }
  lines.push("");

  if (report.pages.length === 0) {
    lines.push(ansi.dim("No pages audited (all discovered pages were ignored or redirects)."));
    lines.push("");
    return lines.join("\n");
  }

  const visiblePages = failuresOnly
    ? report.pages.filter((p) => p.status !== "pass")
    : report.pages;

  lines.push(ansi.bold("Pages:"));
  if (visiblePages.length === 0) {
    lines.push(ansi.green(`  All ${report.pages.length} pages passed.`));
  } else {
    const pathWidth = Math.min(48, Math.max(12, ...visiblePages.map((p) => p.path.length)));
    for (const page of visiblePages) {
      const { icon, label } = statusPaint(page.status);
      lines.push(`${icon} ${page.path.padEnd(pathWidth)}  ${String(page.score).padEnd(4)}  ${label}`);
    }
    const hidden = report.pages.length - visiblePages.length;
    if (hidden > 0) {
      lines.push(ansi.dim(`  ${hidden} passing page(s) hidden (--failures-only).`));
    }
  }

  if (report.siteWarnings && report.siteWarnings.length > 0) {
    lines.push("", ansi.bold("Site issues:"));
    for (const w of report.siteWarnings) {
      lines.push(`  ${severityBullet(w)}${w.message}`);
      lines.push(ansi.dim(`    ${formatPathList(w.pages)}`));
    }
  }

  const groups = groupWarningSignatures(report.pages);
  const shared = groups.filter((g) => g.paths.length >= 2);
  const sharedKeys = new Set(shared.map((g) => g.key));

  if (shared.length > 0) {
    lines.push("", ansi.bold("Shared issues:"));
    for (const g of sortGroups(shared)) {
      lines.push(`  ${severityBullet(g.warning)}${g.paths.length} pages: ${g.warning.message}`);
      lines.push(ansi.dim(`    ${formatPathList(g.paths)}`));
    }
  }

  for (const page of report.pages) {
    if (page.status === "pass") continue;
    const unique = page.warnings.filter((w) => !sharedKeys.has(warningKey(w)));
    if (unique.length === 0 && page.warnings.length > 0) continue;

    lines.push("", ansi.bold(page.path));
    if (unique.length > 0) {
      lines.push(ansi.dim("Issues:"));
      for (const w of sortWarnings(unique)) {
        lines.push(`  ${severityBullet(w)}${w.message}`);
      }
    }
    appendFixHint(lines, page, report);
  }

  if (shared.length > 0) {
    const failingPages = report.pages.filter((p) => p.status !== "pass");
    const onlyShared =
      failingPages.length > 0 &&
      failingPages.every((p) => p.warnings.every((w) => sharedKeys.has(warningKey(w))));
    if (onlyShared) {
      lines.push("", ansi.dim("Fixes for the shared issues above:"));
      appendFixHint(lines, failingPages[0], report);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderSingle(report: AuditReport, lines: string[]): string {
  const page = report.pages[0];
  if (!page) return [...lines, ansi.red("No page audited."), ""].join("\n");

  lines.push(`Score: ${page.score}/100 (${statusPaint(page.status).label})`);
  lines.push("");
  lines.push(ansi.bold("Checks:"));
  for (const c of page.checks) {
    const mark =
      c.status === "pass"
        ? ansi.green("✓")
        : c.status === "partial"
          ? ansi.yellow("◐")
          : c.status === "skipped"
            ? ansi.dim("–")
            : ansi.red("✕");
    const pts =
      c.status === "skipped"
        ? ansi.dim("(skipped)")
        : c.status === "partial"
          ? ansi.dim(`(${c.earned}/${c.weight})`)
          : ansi.dim(`(${c.weight})`);
    lines.push(`  ${mark} ${c.label} ${pts}`);
  }

  lines.push("", ansi.bold("Metadata:"));
  lines.push(formatField("title", page.meta.title));
  lines.push(formatField("description", page.meta.description));
  lines.push(formatField("og:image", page.meta.image));
  lines.push(formatField("og:url", page.meta.url));
  lines.push(formatField("canonical", page.meta.canonical));
  lines.push(formatField("twitter:card", page.meta.twitterCard));

  const images = page.images && page.images.length > 0 ? page.images : page.image ? [page.image] : [];
  if (images.length > 0) {
    lines.push("", ansi.bold(images.length > 1 ? "Images:" : "Image:"));
    for (const img of images) {
      lines.push(`  Source: ${img.resolvedSource}`);
      if (img.width && img.height) {
        lines.push(`  Dimensions: ${img.width}x${img.height}`);
      }
      if (img.sizeBytes !== null) lines.push(`  Size: ${formatBytes(img.sizeBytes)}`);
      if (img.contentType) lines.push(`  Content type: ${img.contentType}`);
    }
  }

  if (page.warnings.length > 0) {
    lines.push("", ansi.bold("Issues:"));
    for (const w of sortWarnings(page.warnings)) {
      lines.push(`  ${severityBullet(w)}${w.message}`);
    }
  }

  if (page.status !== "pass") {
    lines.push("");
    appendFixHint(lines, page, report);
  }

  if (page.platforms.length > 0) {
    lines.push("", ansi.bold("Platforms:"));
    for (const line of renderPlatformTable(page.platforms)) lines.push("  " + line);
  }

  lines.push("");
  return lines.join("\n");
}

function renderPlatformTable(platforms: PlatformPreview[]): string[] {
  const labelWidth = Math.max(...platforms.map((p) => p.label.length));
  const layoutWidth = Math.max(...platforms.map((p) => CARD_LAYOUT_LABELS[p.cardLayout].length));

  return platforms.map((p) => {
    const errors = p.warnings.filter((w) => w.severity === "error");
    const warns = p.warnings.filter((w) => w.severity === "warning");
    const icon =
      errors.length > 0 ? ansi.red("✕") : warns.length > 0 ? ansi.yellow("⚠") : ansi.green("✓");
    const label = p.label.padEnd(labelWidth);
    const layout = CARD_LAYOUT_LABELS[p.cardLayout].padEnd(layoutWidth);
    const truncated = [p.title, p.description].filter((f) => f.truncated).length;
    const truncatedNote = truncated > 0 ? ansi.dim(` (${truncated} truncated)`) : "";

    const reason = errors[0]?.message ?? warns[0]?.message ?? null;
    const reasonNote = reason ? ansi.dim(` - ${truncateText(reason, 85)}`) : "";

    return `${icon} ${label}  ${ansi.dim("→")} ${layout}${truncatedNote}${reasonNote}`;
  });
}

function truncateText(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function warningKey(w: Warning): string {
  return `${w.code}\0${w.message}`;
}

function groupWarningSignatures(
  pages: PageReport[],
): Array<{ key: string; warning: Warning; paths: string[] }> {
  const map = new Map<string, { key: string; warning: Warning; paths: string[] }>();
  for (const page of pages) {
    const seenOnPage = new Set<string>();
    for (const w of page.warnings) {
      const key = warningKey(w);
      if (seenOnPage.has(key)) continue;
      seenOnPage.add(key);
      const existing = map.get(key);
      if (existing) {
        existing.paths.push(page.path);
      } else {
        map.set(key, { key, warning: w, paths: [page.path] });
      }
    }
  }
  return [...map.values()];
}

function sortGroups(
  groups: Array<{ key: string; warning: Warning; paths: string[] }>,
): Array<{ key: string; warning: Warning; paths: string[] }> {
  return [...groups].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.warning.severity] - SEVERITY_ORDER[b.warning.severity];
    if (sev !== 0) return sev;
    return b.paths.length - a.paths.length;
  });
}

function formatPathList(paths: string[], maxShow = 8): string {
  if (paths.length <= maxShow) return paths.join(", ");
  return `${paths.slice(0, maxShow).join(", ")}, +${paths.length - maxShow} more`;
}

function formatField(label: string, value: string | null): string {
  return value === null ? `  ${label}: ${ansi.dim("(missing)")}` : `  ${label}: ${value}`;
}

function severityBullet(w: Warning): string {
  if (w.severity === "error") return ansi.red("• ");
  if (w.severity === "warning") return ansi.yellow("• ");
  return ansi.dim("• ");
}

function sortWarnings(warnings: Warning[]): Warning[] {
  return [...warnings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function appendFixHint(lines: string[], page: PageReport, report: AuditReport): void {
  const fixes = fixesForPage(page, report);
  if (fixes.length === 0) return;
  const points = fixes.reduce((s, f) => s + f.weight, 0);
  const target = Math.min(100, page.score + points);
  const headline =
    points > 0 ? `Fixes (${page.score} → ${target}, +${points}):` : "Fixes:";
  lines.push(ansi.bold(headline));
  const labelWidth = Math.max(...fixes.map((f) => f.label.length));
  for (const fix of fixes) {
    const weight = fix.weight > 0 ? ansi.cyan(`+${fix.weight}`.padStart(3)) : ansi.dim("  ·");
    lines.push(`  ${weight}  ${fix.label.padEnd(labelWidth)}  ${snippetPreview(fix)}`);
  }
}

function snippetPreview(fix: Fix): string {
  if (!fix.snippet) return ansi.dim(truncateText(fix.explain, 70));
  return ansi.dim(truncateText(fix.snippet, 70));
}
