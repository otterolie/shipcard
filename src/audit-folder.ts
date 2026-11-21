import fs from "node:fs/promises";
import path from "node:path";
import { auditHtml } from "./audit-html.js";
import { extractMetaWithStats } from "./extract-meta.js";
import { buildReport } from "./report.js";
import { createImageCache, type ImageProbeCache } from "./validate-image.js";
import { VERSION } from "./version.js";
import { isIgnoredPath, mapWithConcurrency, SKIP_DIR_NAMES } from "./utils.js";
import type { AuditOptions, AuditReport, PageReport, SkippedPage } from "./types.js";

const BUILD_DIR_NAMES = ["dist", "out", "build", "public", ".output", "export"];
const BUILD_DIR_SET = new Set(BUILD_DIR_NAMES);
const SPLIT_OUTPUT_DIR_NAMES = new Set(["client", "public", "static", "www"]);
const PAGE_CONCURRENCY = 8;

export class NoHtmlFilesError extends Error {
  constructor(folder: string, hint?: string) {
    super(hint ? `No .html files found in ${folder}. ${hint}` : `No .html files found in ${folder}.`);
    this.name = "NoHtmlFilesError";
  }
}

/**
 * Scan a folder for .html files and audit each one.
 * Auto-detects standard build directories and split client/server outputs,
 * supports --ignore globs, and skips <meta http-equiv="refresh"> redirect stubs by default.
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

  const tasks: Array<{ file: string; logical: string; root: string }> = [];
  const skipped: SkippedPage[] = [];
  const seen = new Set<string>();
  let discoveredAny = false;

  for (const root of roots) {
    const files = await listHtmlFiles(root);
    for (const rel of files) {
      const full = path.join(root, rel);
      const logical = "/" + path.relative(absFolder, full).split(path.sep).join("/");
      if (seen.has(logical)) continue;
      seen.add(logical);
      discoveredAny = true;

      if (isIgnoredPath(logical, options.ignore)) {
        skipped.push({ path: logical, reason: "ignored" });
        continue;
      }

      tasks.push({ file: full, logical, root });
    }
  }

  if (!discoveredAny) {
    const hint = await missingHtmlHint(absFolder);
    throw new NoHtmlFilesError(folder, hint);
  }

  const imageCache = createImageCache();
  const outcomes = await mapWithConcurrency(tasks, PAGE_CONCURRENCY, ({ file, logical, root }) =>
    auditOnePage(file, logical, root, absFolder, options, imageCache),
  );

  const pages: PageReport[] = [];
  for (const outcome of outcomes) {
    if ("skipped" in outcome) {
      skipped.push(outcome.skipped);
    } else {
      pages.push(outcome.page);
    }
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  return buildReport(pages, {
    version: options.version ?? VERSION,
    type: "folder",
    input: folder,
    skipped,
  });
}

async function resolveScanRoots(absFolder: string): Promise<string[]> {
  const direct = await listHtmlFiles(absFolder);
  if (direct.length > 0) {
    const buildRoots = nestedRootsFor(absFolder, direct, BUILD_DIR_SET);
    if (buildRoots) {
      const resolved: string[] = [];
      for (const { dir, subPaths } of buildRoots) {
        const split = nestedRootsFor(dir, subPaths, SPLIT_OUTPUT_DIR_NAMES);
        resolved.push(...(split ? split.map((s) => s.dir) : [dir]));
      }
      return resolved;
    }

    const splitRoots = nestedRootsFor(absFolder, direct, SPLIT_OUTPUT_DIR_NAMES);
    if (splitRoots) return splitRoots.map((s) => s.dir);
    return [absFolder];
  }

  const roots: string[] = [];
  for (const name of BUILD_DIR_NAMES) {
    const candidate = path.join(absFolder, name);
    try {
      const st = await fs.stat(candidate);
      if (!st.isDirectory()) continue;
      const html = await listHtmlFiles(candidate);
      if (html.length === 0) continue;
      const split = nestedRootsFor(candidate, html, SPLIT_OUTPUT_DIR_NAMES);
      roots.push(...(split ? split.map((s) => s.dir) : [candidate]));
    } catch {
      // missing
    }
  }
  return roots;
}

/**
 * If every HTML file lives inside one of `allowedDirs`, group by those subfolders
 * so root-relative image paths resolve against the actual static output root.
 */
function nestedRootsFor(
  absFolder: string,
  relativeHtmlPaths: string[],
  allowedDirs: Set<string>,
): Array<{ dir: string; subPaths: string[] }> | null {
  const grouped = new Map<string, string[]>();
  for (const rel of relativeHtmlPaths) {
    const sepIdx = rel.indexOf(path.sep);
    if (sepIdx === -1) return null;
    const first = rel.slice(0, sepIdx);
    if (!allowedDirs.has(first)) return null;
    const rest = rel.slice(sepIdx + 1);
    (grouped.get(first) ?? grouped.set(first, []).get(first)!).push(rest);
  }
  if (grouped.size === 0) return null;
  return [...grouped.keys()]
    .sort()
    .map((seg) => ({ dir: path.join(absFolder, seg), subPaths: grouped.get(seg)! }));
}

async function missingHtmlHint(absFolder: string): Promise<string> {
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
    return `Found ${existing.join(", ")} with no HTML inside. Build the site first or pass the output folder.`;
  }
  return "Pass a built site folder (for example ./dist, ./out, ./build, or ./public).";
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
  searchRoot: string,
  options: AuditOptions,
  imageCache: ImageProbeCache,
): Promise<{ page: PageReport } | { skipped: SkippedPage }> {
  try {
    const html = await fs.readFile(file, "utf8");
    if (!options.includeRedirects && extractMetaWithStats(html).isRedirect) {
      return { skipped: { path: logicalPath, reason: "redirect" } };
    }
    const page = await auditHtml(html, {
      source: file,
      path: logicalPath,
      sourceFile: file,
      baseDir,
      searchRoot,
      validateImages: options.validateImages,
      timeoutMs: options.timeoutMs,
      offline: options.offline,
      imageCache,
    });
    return { page };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { page: failedPage(logicalPath, file, message) };
  }
}

export function failedPage(logicalPath: string, source: string, reason: string): PageReport {
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
