import { URL } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const RECOMMENDED_IMAGE_WIDTH = 1200;
export const RECOMMENDED_IMAGE_HEIGHT = 630;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export const SKIP_DIR_NAMES = new Set([
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

const ELSEWHERE_SEARCH_MAX_DIRS = 4000;

/**
 * Bounded BFS for `relativePath` anywhere under `searchRoot` (skipping `skipDir`).
 * Helps distinguish a missing asset from scanning the wrong build output folder.
 */
export async function findFileElsewhere(
  searchRoot: string,
  relativePath: string,
  skipDir?: string,
): Promise<string | null> {
  const queue: string[] = [searchRoot];
  let visited = 0;

  while (queue.length > 0 && visited < ELSEWHERE_SEARCH_MAX_DIRS) {
    const dir = queue.shift()!;
    visited++;

    if (dir !== skipDir) {
      const candidate = path.join(dir, relativePath);
      if (isInsideDir(searchRoot, candidate)) {
        try {
          const st = await fsp.stat(candidate);
          if (st.isFile()) return candidate;
        } catch {
          // keep looking
        }
      }
    }

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) continue;
      queue.push(path.join(dir, entry.name));
    }
  }

  return null;
}

export function isInsideDir(baseDir: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

export function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//");
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLocalhostUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return LOCALHOST_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

export function isRelativeReference(value: string): boolean {
  return !isAbsoluteUrl(value) && !isDataUrl(value);
}

export function isRelativeOrPathOnly(value: string | null | undefined): boolean {
  if (!value) return false;
  if (isDataUrl(value)) return false;
  if (isHttpUrl(value)) return false;
  return true;
}

export type ResolveContext = {
  baseUrl?: string;
  baseDir?: string;
  sourceUrl?: string;
  sourceFile?: string;
  searchRoot?: string;
};

/**
 * Resolve an image reference against its HTML's location.
 * When baseDir is set, absolute http(s) URLs map to local files by pathname if present.
 */
export function resolveReference(
  reference: string,
  ctx: ResolveContext,
): { resolved: string; external: boolean; localPath?: string } {
  if (isDataUrl(reference)) return { resolved: reference, external: false };

  if (reference.startsWith("//")) {
    const https = `https:${reference}`;
    const local = localFileForHttpUrl(https, ctx.baseDir);
    if (local) return { resolved: local, external: false, localPath: local };
    return { resolved: https, external: true };
  }

  if (isAbsoluteUrl(reference)) {
    if (isHttpUrl(reference)) {
      const local = localFileForHttpUrl(reference, ctx.baseDir);
      if (local) return { resolved: local, external: false, localPath: local };
    }
    return { resolved: reference, external: true };
  }

  // Remote page audits resolve relative references against the page URL.
  const urlBase = ctx.sourceUrl ?? ctx.baseUrl;
  if (urlBase) {
    try {
      return { resolved: new URL(reference, urlBase).toString(), external: true };
    } catch {
      // fall through to filesystem
    }
  }

  const cleanRef = safeDecode(stripQueryAndHash(reference));

  // Root-relative paths anchor at baseDir, not the HTML file's directory.
  if (cleanRef.startsWith("/") && ctx.baseDir) {
    const resolved = path.resolve(ctx.baseDir, "." + cleanRef);
    if (isInsideDir(ctx.baseDir, resolved)) {
      return { resolved, external: false, localPath: resolved };
    }
    return { resolved: reference, external: false };
  }

  const dirBase = ctx.sourceFile ? path.dirname(ctx.sourceFile) : ctx.baseDir;
  if (dirBase) {
    const resolved = path.resolve(dirBase, cleanRef);
    const rootBoundary = ctx.baseDir ?? dirBase;
    if (isInsideDir(rootBoundary, resolved)) {
      return { resolved, external: false, localPath: resolved };
    }
    return { resolved: reference, external: false };
  }

  return { resolved: reference, external: false };
}

/**
 * Map https://host/path/to/img.png to baseDir/path/to/img.png (or baseDir/public/...)
 * when the file exists inside baseDir.
 */
export function localFileForHttpUrl(url: string, baseDir?: string): string | null {
  if (!baseDir) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (!pathname || pathname === "/") return null;

  const candidates = [
    path.resolve(baseDir, "." + pathname),
    path.resolve(baseDir, "public", "." + pathname),
  ];

  for (const candidate of candidates) {
    if (!isInsideDir(baseDir, candidate)) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
