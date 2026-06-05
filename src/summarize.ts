import type { AuditReport, PageReport } from "./types.js";

/**
 * Compute the AuditReport.summary block from a list of pages.
 * The overall score is the mean of page scores (rounded), or 0 when no pages.
 */
export function summarize(pages: PageReport[]): AuditReport["summary"] {
  if (pages.length === 0) {
    return { score: 0, pagesScanned: 0, ready: 0, warnings: 0, failed: 0 };
  }
  const total = pages.reduce((acc, p) => acc + p.score, 0);
  const score = Math.round(total / pages.length);
  let ready = 0;
  let warnings = 0;
  let failed = 0;
  for (const p of pages) {
    if (p.status === "ready") ready++;
    else if (p.status === "warning") warnings++;
    else failed++;
  }
  return {
    score,
    pagesScanned: pages.length,
    ready,
    warnings,
    failed,
  };
}
