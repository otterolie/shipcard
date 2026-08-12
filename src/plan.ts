import { fixesForPage, type Fix } from "./fixes.js";
import { statusFromScore } from "./score.js";
import type { AuditReport, PageReport } from "./types.js";

/**
 * One concrete thing an agent (or human) should do.
 * Designed to be JSON-serializable and copy-paste actionable.
 */
export type Action = {
  /** Stable id, usually matches Fix.id (e.g. fix-og-image-combined). */
  id: string;
  /** 1 = do first. */
  priority: number;
  /** Score points recovered if applied on every listed page (sum of per-page weights). */
  impact: number;
  /** Imperative title. */
  title: string;
  /** Why this matters. */
  why: string;
  /** What to do in plain language. */
  how: string;
  /** HTML snippet when the fix is a tag change. */
  snippet?: string;
  category: Fix["category"];
  /** Logical page paths (e.g. /pricing.html). */
  pages: string[];
  /** Filesystem paths when the audit was local (page.source). */
  files: string[];
};

export type Plan = {
  score: number;
  status: "ready" | "warning" | "fail";
  pagesScanned: number;
  /** Short paragraph an LLM can read first. */
  summary: string;
  /** Ordered work list — group identical fixes across pages. */
  actions: Action[];
  /** Per-page snapshot for agents that want to patch one file at a time. */
  pages: Array<{
    path: string;
    file: string | null;
    score: number;
    status: PageReport["status"];
    issues: string[];
    actionIds: string[];
  }>;
  /** Next command suggestions for the agent loop. */
  next: string[];
};

/** Build an agent-friendly action plan from an AuditReport. */
export function planFromReport(report: AuditReport): Plan {
  const status = statusFromScore(report.summary.score);
  const byId = new Map<
    string,
    {
      fix: Fix;
      pages: string[];
      files: string[];
      impact: number;
    }
  >();

  const pageSnapshots: Plan["pages"] = [];

  for (const page of report.pages) {
    const fixes = fixesForPage(page, report);
    const actionIds: string[] = [];
    for (const fix of fixes) {
      actionIds.push(fix.id);
      const existing = byId.get(fix.id);
      const file = isFilesystemPath(page.source) ? page.source : null;
      if (existing) {
        if (!existing.pages.includes(page.path)) existing.pages.push(page.path);
        if (file && !existing.files.includes(file)) existing.files.push(file);
        existing.impact += fix.weight;
      } else {
        byId.set(fix.id, {
          fix,
          pages: [page.path],
          files: file ? [file] : [],
          impact: fix.weight,
        });
      }
    }

    const issues = page.warnings
      .filter((w) => w.severity === "error" || w.severity === "warning")
      .map((w) => w.message);

    pageSnapshots.push({
      path: page.path,
      file: isFilesystemPath(page.source) ? page.source : null,
      score: page.score,
      status: page.status,
      issues,
      actionIds,
    });
  }

  const actions: Action[] = [...byId.values()]
    .map((entry) => ({
      id: entry.fix.id,
      priority: 0,
      impact: entry.impact,
      title: entry.fix.label,
      why: entry.fix.explain,
      how: howForFix(entry.fix, entry.pages.length, entry.files.length > 0),
      snippet: entry.fix.snippet,
      category: entry.fix.category,
      pages: entry.pages,
      files: entry.files,
    }))
    .sort((a, b) => {
      if (b.impact !== a.impact) return b.impact - a.impact;
      return a.title.localeCompare(b.title);
    })
    .map((a, i) => ({ ...a, priority: i + 1 }));

  return {
    score: report.summary.score,
    status,
    pagesScanned: report.summary.pagesScanned,
    summary: buildSummary(report, actions),
    actions,
    pages: pageSnapshots,
    next: buildNextHints(report, actions),
  };
}

function isFilesystemPath(source: string): boolean {
  if (!source || source === "<stdin>") return false;
  if (/^https?:\/\//i.test(source)) return false;
  return true;
}

function howForFix(fix: Fix, pageCount: number, hasFiles: boolean): string {
  const scope =
    pageCount > 1
      ? `Apply on all ${pageCount} affected pages (prefer a shared layout/template if they share one).`
      : hasFiles
        ? "Edit the page's HTML <head> (or the framework metadata API that emits it)."
        : "Update the HTML <head> (or the metadata API that emits these tags).";

  if (fix.snippet) {
    return `${scope} Insert or replace with: ${fix.snippet}`;
  }
  if (fix.category === "image") {
    return `${scope} Provide a real image asset (≥1200×630, <5MB, https URL in production). Re-run shipcard after the file exists in the build output.`;
  }
  if (fix.category === "duplicate") {
    return `${scope} Search the template for duplicate og:* / twitter:* / canonical tags and keep exactly one of each.`;
  }
  return scope;
}

function buildSummary(report: AuditReport, actions: Action[]): string {
  const { summary } = report;
  const statusWord =
    summary.score >= 90 ? "ready to ship" : summary.score >= 70 ? "has minor leaks" : "is blocked";
  const parts = [
    `Fleet score ${summary.score}/100 across ${summary.pagesScanned} page(s) — ${statusWord}.`,
    `${summary.ready} ready, ${summary.warnings} warning, ${summary.failed} failed.`,
  ];
  if (actions.length === 0) {
    parts.push("No fixes needed.");
  } else {
    const top = actions[0];
    const more = actions.length - 1;
    parts.push(
      more > 0
        ? `Top action: ${top.title} (+${top.impact} pts across ${top.pages.length} page(s)); ${more} more action(s).`
        : `Top action: ${top.title} (+${top.impact} pts).`,
    );
  }
  return parts.join(" ");
}

function buildNextHints(report: AuditReport, actions: Action[]): string[] {
  const hints: string[] = [];
  const input = report.target.input;

  if (actions.length === 0) {
    hints.push("Nothing to do — social cards look good.");
    return hints;
  }

  if (actions.some((a) => a.category === "image" || a.id.includes("og-image"))) {
    hints.push(
      "If this is a pre-launch local folder, re-run with --offline so absolute production image URLs map to files in the build (or fail clearly without network 404 noise).",
    );
  }

  const file = actions.flatMap((a) => a.files).find(Boolean);
  if (file) {
    hints.push(`Start with file: ${file}`);
  } else if (actions[0]?.pages[0]) {
    hints.push(`Start with page: ${actions[0].pages[0]}`);
  }

  if (actions[0]?.snippet) {
    hints.push(`First snippet: ${actions[0].snippet}`);
  }

  hints.push(`After edits, rebuild if needed and re-run: shipcard ${shellQuote(input)} --offline --json`);
  return hints;
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}
