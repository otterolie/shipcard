import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { auditHtml } from "./audit-html.js";
import { summarize } from "./summarize.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport, PageReport } from "./types.js";

export type AuditFolderOptions = AuditOptions & { version?: string };

export class NoHtmlFilesError extends Error {
  constructor(folder: string) {
    super(`No .html files found in ${folder}.`);
    this.name = "NoHtmlFilesError";
  }
}

/**
 * Scan a folder for .html files and audit each one. Image references are resolved
 * relative to the HTML file (or to the folder root for root-relative paths).
 */
export async function auditFolder(
  folder: string,
  options: AuditFolderOptions,
): Promise<AuditReport> {
  const absFolder = path.resolve(folder);
  const stat = await fs.stat(absFolder).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Folder not found: ${folder}`);
  }

  const files = (
    await fg("**/*.html", {
      cwd: absFolder,
      onlyFiles: true,
      dot: false,
      ignore: ["**/node_modules/**"],
    })
  ).sort();

  if (files.length === 0) throw new NoHtmlFilesError(folder);

  const pages: PageReport[] = [];
  for (const rel of files) {
    const full = path.join(absFolder, rel);
    const logicalPath = "/" + rel.split(path.sep).join("/");
    pages.push(await auditOnePage(full, logicalPath, absFolder, options));
  }

  return {
    tool: "shipcard",
    version: options.version ?? VERSION,
    createdAt: new Date().toISOString(),
    target: { type: "folder", input: folder },
    summary: summarize(pages),
    pages,
  };
}

async function auditOnePage(
  file: string,
  logicalPath: string,
  baseDir: string,
  options: AuditFolderOptions,
): Promise<PageReport> {
  try {
    const html = await fs.readFile(file, "utf8");
    return await auditHtml(html, {
      source: file,
      path: logicalPath,
      sourceFile: file,
      baseDir,
      validateImages: options.validateImages,
      timeoutMs: options.timeoutMs,
    });
  } catch (err) {
    // One corrupt page shouldn't sink the whole scan. Surface it as a failed page.
    const message = err instanceof Error ? err.message : String(err);
    return failedPage(logicalPath, file, message);
  }
}

function failedPage(logicalPath: string, source: string, reason: string): PageReport {
  return {
    path: logicalPath,
    source,
    score: 0,
    status: "fail",
    meta: {
      title: null,
      description: null,
      image: null,
      url: null,
      type: null,
      siteName: null,
      canonical: null,
      twitterCard: null,
      twitterTitle: null,
      twitterDescription: null,
      twitterImage: null,
      raw: { titleTag: null, metaDescription: null, openGraph: {}, twitter: {}, links: {} },
    },
    image: null,
    checks: [],
    warnings: [
      {
        severity: "error",
        code: "page-audit-failed",
        message: `Could not audit page: ${reason}`,
      },
    ],
    platforms: [],
  };
}
