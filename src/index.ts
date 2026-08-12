export { extractMeta } from "./extract-meta.js";
export {
  scorePage,
  statusFromScore,
  hasDuplicateCoreTags,
  findDuplicateCoreTags,
} from "./score.js";
export { validateImage } from "./validate-image.js";
export { auditHtml } from "./audit-html.js";
export { auditUrl } from "./audit-url.js";
export { auditFolder, NoHtmlFilesError } from "./audit-folder.js";
export { renderTerminal } from "./render-terminal.js";
export { summarize } from "./summarize.js";
export { platformPreviews } from "./platforms.js";
export { renderPreviewHtml } from "./preview-html.js";
export { fixesForPage, fixBundle, type Fix, type FixCategory, applyFixes } from "./fixes.js";
export { planFromReport, type Plan, type Action } from "./plan.js";
export { VERSION as version } from "./version.js";
export type { AuditOptions, AuditReport } from "./types.js";

import fs from "node:fs/promises";
import path from "node:path";
import { auditHtml } from "./audit-html.js";
import { auditUrl } from "./audit-url.js";
import { auditFolder } from "./audit-folder.js";
import { buildReport } from "./report.js";
import { planFromReport, type Plan } from "./plan.js";
import { isHttpUrl } from "./utils.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport } from "./types.js";

/**
 * Audit a URL, folder, single .html file, or "-" for stdin.
 * Prefer this over the lower-level helpers when you just have a target string.
 */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditReport> {
  const version = options.version ?? VERSION;

  if (isHttpUrl(target)) {
    return auditUrl(target, { ...options, version });
  }

  if (target === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const html = Buffer.concat(chunks).toString("utf8") || "<html><head></head><body></body></html>";
    const page = await auditHtml(html, {
      source: "<stdin>",
      path: "/stdin.html",
      validateImages: options.validateImages,
      timeoutMs: options.timeoutMs,
      offline: options.offline,
    });
    return buildReport([page], { version, type: "folder", input: "-" });
  }

  const abs = path.resolve(target);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) {
    throw new Error(`Target not found: ${target}`);
  }

  if (stat.isFile() && /\.(html|htm)$/i.test(abs)) {
    const html = await fs.readFile(abs, "utf8");
    const page = await auditHtml(html, {
      source: target,
      path: "/" + path.basename(abs),
      sourceFile: abs,
      baseDir: path.dirname(abs),
      validateImages: options.validateImages,
      timeoutMs: options.timeoutMs,
      offline: options.offline,
    });
    return buildReport([page], { version, type: "folder", input: target });
  }

  if (stat.isDirectory()) {
    return auditFolder(abs, { ...options, version });
  }

  throw new Error(`Target is not a directory or .html file: ${target}`);
}

/**
 * One-shot for agents: audit + prioritized action plan.
 * Defaults offline=true for non-URL targets so pre-launch image checks stay local.
 */
export async function advise(
  target: string,
  options: AuditOptions = {},
): Promise<{ report: AuditReport; plan: Plan }> {
  const offline = options.offline !== undefined ? options.offline : !isHttpUrl(target);
  const report = await audit(target, { ...options, offline });
  const plan = planFromReport(report);
  return { report: { ...report, plan }, plan };
}
