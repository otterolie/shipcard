import { summarize } from "./summarize.js";
import type {
  AuditReport,
  PageReport,
  SiteWarning,
  SkippedPage,
  TargetType,
} from "./types.js";

export function buildReport(
  pages: PageReport[],
  opts: {
    version: string;
    type: TargetType;
    input: string;
    skipped?: SkippedPage[];
  },
): AuditReport {
  const summary = summarize(pages);
  const skipped = opts.skipped && opts.skipped.length > 0 ? opts.skipped : undefined;
  if (skipped) summary.skipped = skipped.length;

  const siteWarnings = pages.length >= 2 ? findCrossPageWarnings(pages) : [];

  const report: AuditReport = {
    tool: "shipcard",
    version: opts.version,
    createdAt: new Date().toISOString(),
    target: { type: opts.type, input: opts.input },
    summary,
    pages,
  };
  if (siteWarnings.length > 0) report.siteWarnings = siteWarnings;
  if (skipped) report.skipped = skipped;
  return report;
}

/** Detect identical titles or descriptions repeated across multiple pages. */
export function findCrossPageWarnings(pages: PageReport[]): SiteWarning[] {
  const warnings: SiteWarning[] = [];
  collectDuplicates(pages, "title", "duplicate-site-title", (p) => p.meta.title, warnings);
  collectDuplicates(
    pages,
    "description",
    "duplicate-site-description",
    (p) => p.meta.description,
    warnings,
  );
  return warnings;
}

function collectDuplicates(
  pages: PageReport[],
  label: string,
  code: string,
  getter: (p: PageReport) => string | null,
  out: SiteWarning[],
): void {
  const byValue = new Map<string, string[]>();
  for (const page of pages) {
    const value = getter(page)?.trim();
    if (!value) continue;
    (byValue.get(value) ?? byValue.set(value, []).get(value)!).push(page.path);
  }

  for (const [value, paths] of byValue) {
    if (paths.length < 2) continue;
    const preview = value.length > 60 ? value.slice(0, 59) + "…" : value;
    out.push({
      severity: "warning",
      code,
      message: `${paths.length} pages share the same ${label}: "${preview}"`,
      pages: paths,
    });
  }
}
