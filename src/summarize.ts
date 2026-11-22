import type { AuditReport, PageReport } from "./types.js";

/** Compute aggregate counts, rounded mean score, and minimum score for a list of pages. */
export function summarize(pages: PageReport[]): AuditReport["summary"] {
  if (pages.length === 0) {
    return { score: 0, minScore: 0, pagesScanned: 0, passed: 0, warnings: 0, failed: 0 };
  }
  let total = 0;
  let minScore = pages[0].score;
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  for (const p of pages) {
    total += p.score;
    if (p.score < minScore) minScore = p.score;
    if (p.status === "pass") passed++;
    else if (p.status === "warn") warnings++;
    else failed++;
  }
  return {
    score: Math.round(total / pages.length),
    minScore,
    pagesScanned: pages.length,
    passed,
    warnings,
    failed,
  };
}
