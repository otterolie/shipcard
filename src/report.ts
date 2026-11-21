import { summarize } from "./summarize.js";
import type { AuditReport, PageReport, TargetType } from "./types.js";

export function buildReport(
  pages: PageReport[],
  opts: { version: string; type: TargetType; input: string },
): AuditReport {
  return {
    tool: "shipcard",
    version: opts.version,
    createdAt: new Date().toISOString(),
    target: { type: opts.type, input: opts.input },
    summary: summarize(pages),
    pages,
  };
}
