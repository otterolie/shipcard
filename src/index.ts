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
export { VERSION as version } from "./version.js";

import fs from "node:fs/promises";
import path from "node:path";
import { isHttpUrl } from "./utils.js";
import { auditHtml } from "./audit-html.js";
import { summarize } from "./summarize.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport } from "./types.js";

export type { AuditOptions, AuditReport } from "./types.js";

export async function audit(target: string, options: AuditOptions = {}): Promise<AuditReport> {
  const version = options.version ?? VERSION;

  if (isHttpUrl(target)) {
    // delegate (it accepts the extra version? via spread in practice)
    return (await import("./audit-url.js")).auditUrl(target, { ...options, version } as any);
  }

  // Check for single .html file
  try {
    const stat = await fs.stat(target);
    if (stat.isFile() && /\.(html|htm)$/i.test(target)) {
      const html = await fs.readFile(target, "utf8");
      const page = await auditHtml(html, {
        source: target,
        path: "/" + path.basename(target),
        sourceFile: target,
        baseDir: path.dirname(target),
        ...options,
      });
      return {
        tool: "shipcard",
        version,
        createdAt: new Date().toISOString(),
        target: { type: "folder", input: target },
        summary: summarize([page]),
        pages: [page],
      };
    }
  } catch {
    // fall through to folder
  }

  return (await import("./audit-folder.js")).auditFolder(target, { ...options, version } as any);
}


