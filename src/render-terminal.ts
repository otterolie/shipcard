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
  const body =
    report.target.type === "folder" ? renderFolder(report, lines) : renderSingle(report, lines);
  return appendWhatToDo(body, report);
}

function appendWhatToDo(text: string, report: AuditReport): string {
  const plan = report.plan;
  if (!plan || plan.actions.length === 0) return text;

  const lines = [text.replace(/\n$/, ""), "", pc.bold("What to do:"), pc.dim(plan.summary)];
  const show = plan.actions.slice(0, 8);
  for (const a of show) {
    const impact = a.impact > 0 ? pc.cyan(`+${a.impact}`) : pc.dim(" · ");
    const scope = a.pages.length > 1 ? pc.dim(` (${a.pages.length} pages)`) : "";
    lines.push(`  ${pc.dim(String(a.priority).padStart(2))}. ${impact}  ${a.title}${scope}`);
    if (a.snippet) {
      lines.push(pc.dim(`      ${a.snippet.length > 88 ? a.snippet.slice(0, 87) + "…" : a.snippet}`));
    } else {
      lines.push(pc.dim(`      ${a.how.length > 100 ? a.how.slice(0, 99) + "…" : a.how}`));
    }
  }
  if (plan.actions.length > show.length) {
    lines.push(pc.dim(`  … +${plan.actions.length - show.length} more (see --json plan.actions)`));
  }
  if (plan.next.length > 0) {
    lines.push(pc.dim(`Next: ${plan.next[0]}`));
  }
  lines.push("");
  return lines.join("\n");
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

  // Group identical leak signatures so 56 copies of the same 404 don't print 56 times.
  const groups = groupWarningSignatures(report.pages);
  const shared = groups.filter((g) => g.paths.length >= 2);
  const sharedKeys = new Set(shared.map((g) => g.key));

  if (shared.length > 0) {
    lines.push("", pc.bold("Shared leaks:"));
    for (const g of sortGroups(shared)) {
      lines.push(`  ${severityBullet(g.warning)}${g.paths.length} pages — ${g.warning.message}`);
      lines.push(pc.dim(`    ${formatPathList(g.paths)}`));
    }
  }

  for (const page of report.pages) {
    if (page.status === "ready") continue;
    const unique = page.warnings.filter((w) => !sharedKeys.has(warningKey(w)));
    // Skip empty page blocks when everything was covered by Shared leaks
    if (unique.length === 0 && page.warnings.length > 0) continue;

    lines.push("");
    lines.push(pc.bold(page.path));
    if (unique.length > 0) {
      lines.push(pc.dim("Leaks:"));
      for (const w of sortWarnings(unique)) {
        lines.push(`  ${severityBullet(w)}${w.message}`);
      }
    } else if (page.warnings.length === 0) {
      // status not ready but no warnings (score-only) — still show fixes
    }
    appendFixHint(lines, page, report);
  }

  // One shared fix summary when many pages share the same failure and we skipped per-page blocks
  if (shared.length > 0) {
    const sample = report.pages.find((p) => p.status !== "ready" && p.warnings.some((w) => sharedKeys.has(warningKey(w))));
    if (sample) {
      const onlyShared = report.pages
        .filter((p) => p.status !== "ready")
        .every((p) => p.warnings.every((w) => sharedKeys.has(warningKey(w))));
      if (onlyShared) {
        lines.push("");
        lines.push(pc.dim("Fixes apply across the shared leaks above (same tags on each page)."));
        appendFixHint(lines, sample, report);
      }
    }
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
    const errors = p.warnings.filter((w) => w.severity === "error");
    const warns = p.warnings.filter((w) => w.severity === "warning");
    const infos = p.warnings.filter((w) => w.severity === "info");
    const icon =
      errors.length > 0 ? pc.red("✕") : warns.length > 0 ? pc.yellow("⚠") : pc.green("✓");
    const label = p.label.padEnd(labelWidth);
    const layout = CARD_LAYOUT_LABELS[p.cardLayout].padEnd(layoutWidth);
    const truncated = [p.title, p.description].filter((f) => f.truncated).length;
    const truncatedNote = truncated > 0 ? pc.dim(` (${truncated} truncated)`) : "";

    // Surface why a platform is ⚠/✕ without requiring --preview
    const reason =
      errors[0]?.message ?? warns[0]?.message ?? (p.cardLayout !== "large" && infos[0]?.message) ?? null;
    const reasonNote =
      reason && (errors.length > 0 || warns.length > 0)
        ? pc.dim(` — ${truncateReason(reason)}`)
        : "";

    return `${icon} ${label}  ${pc.dim("→")} ${layout}${truncatedNote}${reasonNote}`;
  });
}

function truncateReason(msg: string, max = 90): string {
  const one = msg.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function warningKey(w: Warning): string {
  return `${w.code}\0${w.message}`;
}

function groupWarningSignatures(pages: PageReport[]): Array<{ key: string; warning: Warning; paths: string[] }> {
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
  const head = paths.slice(0, maxShow).join(", ");
  return `${head}, … +${paths.length - maxShow} more`;
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
