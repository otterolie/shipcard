export { extractMeta, extractMetaWithStats, type MetaExtraction } from "./extract-meta.js";
export {
  scorePage,
  statusFromScore,
  pageStatus,
  isValidTwitterCard,
  hasDuplicateCoreTags,
  findDuplicateCoreTags,
  type ScoreOptions,
} from "./score.js";
export { validateImage } from "./validate-image.js";
export { auditHtml } from "./audit-html.js";
export { auditUrl } from "./audit-url.js";
export { auditFolder, NoHtmlFilesError } from "./audit-folder.js";
export { auditSitemap, parseSitemapXml } from "./audit-sitemap.js";
export { renderTerminal, type RenderTerminalOptions } from "./render-terminal.js";
export { summarize } from "./summarize.js";
export { platformPreviews } from "./platforms.js";
export { renderPreviewHtml } from "./preview-html.js";
export { fixesForPage, fixBundle, applyFixes, type Fix, type FixCategory } from "./fixes.js";
export { VERSION as version } from "./version.js";
export type {
  AuditOptions,
  AuditReport,
  CardLayout,
  CheckResult,
  CheckStatus,
  ImageAudit,
  PageReport,
  PageStatus,
  Platform,
  PlatformField,
  PlatformImage,
  PlatformPreview,
  Severity,
  SiteWarning,
  SkippedPage,
  SocialMeta,
  TargetType,
  Warning,
} from "./types.js";

import fs from "node:fs/promises";
import path from "node:path";
import { auditHtml } from "./audit-html.js";
import { auditUrl } from "./audit-url.js";
import { auditFolder } from "./audit-folder.js";
import { auditSitemap } from "./audit-sitemap.js";
import { buildReport } from "./report.js";
import { isHttpUrl, isSitemapUrl } from "./utils.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport } from "./types.js";

/** Audit a URL, XML sitemap, folder, single .html file, or "-" for stdin. */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditReport> {
  const version = options.version ?? VERSION;

  if (isHttpUrl(target)) {
    if (options.sitemap || isSitemapUrl(target)) {
      return auditSitemap(target, { ...options, version });
    }
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
    return buildReport([page], { version, type: "stdin", input: "-" });
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
    return buildReport([page], { version, type: "file", input: target });
  }

  if (stat.isDirectory()) {
    return auditFolder(abs, { ...options, version });
  }

  throw new Error(`Target is not a directory or .html file: ${target}`);
}
