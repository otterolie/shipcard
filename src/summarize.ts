import type { AuditReport, PageReport } from "./types.js";

/** Compute aggregate counts and rounded mean score for a list of pages. */
export function summarize(pages: PageReport[]): AuditReport["summary"] {
  if (pages.length === 0) {
    return { score: 0, pagesScanned: 0, passed: 0, warnings: 0, failed: 0 };
  }
  const total = pages.reduce((acc, p) => acc + p.score, 0);
  const score = Math.round(total / pages.length);
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  for (const p of pages) {
    if (p.status === "pass") passed++;
    else if (p.status === "warn") warnings++;
    else failed++;
  }
  return {
    score,
    pagesScanned: pages.length,
    passed,
    warnings,
    failed,
  };
}
