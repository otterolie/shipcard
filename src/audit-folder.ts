import fs from "node:fs/promises";
import path from "node:path";
import { auditHtml } from "./audit-html.js";
import { buildReport } from "./report.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport, PageReport } from "./types.js";

/** Top-level dirs we auto-scan when the target folder itself has no HTML. */
const BUILD_DIR_NAMES = ["dist", "out", "build", "public", ".output", "export"];

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".vercel",
  ".output",
  "storybook-static",
]);

export class NoHtmlFilesError extends Error {
  constructor(folder: string, hint?: string) {
    super(hint ? `No .html files found in ${folder}. ${hint}` : `No .html files found in ${folder}.`);
    this.name = "NoHtmlFilesError";
  }
}

/**
 * Scan a folder for .html files and audit each one. Image references are resolved
 * relative to the HTML file (or to the folder root for root-relative paths).
 * Absolute production image URLs are mapped to local files by pathname when present.
 */
export async function auditFolder(
  folder: string,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const absFolder = path.resolve(folder);
  const stat = await fs.stat(absFolder).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Folder not found: ${folder}`);
  }

  const roots = await resolveScanRoots(absFolder);
  if (roots.length === 0) {
    const hint = await missingHtmlHint(absFolder);
    throw new NoHtmlFilesError(folder, hint);
  }

  const pages: PageReport[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const files = await listHtmlFiles(root);
    for (const rel of files) {
      const full = path.join(root, rel);
      // Logical path relative to the user-facing target folder
      const logical = "/" + path.relative(absFolder, full).split(path.sep).join("/");
      if (seen.has(logical)) continue;
      seen.add(logical);
      // Resolve assets against the scan root (dist/public), not the monorepo root
      pages.push(await auditOnePage(full, logical, root, options));
    }
  }

  if (pages.length === 0) {
    const hint = await missingHtmlHint(absFolder);
    throw new NoHtmlFilesError(folder, hint);
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));

  return buildReport(pages, {
    version: options.version ?? VERSION,
    type: "folder",
    input: folder,
  });
}

/**
 * Prefer HTML under the target itself; if none, scan known build output dirs one level down.
 */
async function resolveScanRoots(absFolder: string): Promise<string[]> {
  const direct = await listHtmlFiles(absFolder);
  if (direct.length > 0) return [absFolder];

  const roots: string[] = [];
  for (const name of BUILD_DIR_NAMES) {
    const candidate = path.join(absFolder, name);
    try {
      const st = await fs.stat(candidate);
      if (!st.isDirectory()) continue;
      const html = await listHtmlFiles(candidate);
      if (html.length > 0) roots.push(candidate);
    } catch {
      // missing
    }
  }
  return roots;
}

async function missingHtmlHint(absFolder: string): Promise<string | undefined> {
  const existing: string[] = [];
  for (const name of BUILD_DIR_NAMES) {
    try {
      const st = await fs.stat(path.join(absFolder, name));
      if (st.isDirectory()) existing.push(`./${name}`);
    } catch {
      // skip
    }
  }
  if (existing.length > 0) {
    return `Found ${existing.join(", ")} but no HTML inside. Build the site first, or point shipcard at the output folder.`;
  }
  return "Point shipcard at a built site folder (./dist, ./out, ./build, ./public).";
}

async function listHtmlFiles(absFolder: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(html|htm)$/i.test(entry.name)) {
        files.push(path.relative(absFolder, path.join(dir, entry.name)));
      }
    }
  }

  await walk(absFolder);
  return files.sort();
}

async function auditOnePage(
  file: string,
  logicalPath: string,
  baseDir: string,
  options: AuditOptions,
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
      offline: options.offline,
    });
  } catch (err) {
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
    images: [],
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
