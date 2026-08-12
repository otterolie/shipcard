import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";

export const RECOMMENDED_IMAGE_WIDTH = 1200;
export const RECOMMENDED_IMAGE_HEIGHT = 630;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

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

/** Path-only values that aren't absolute http(s). */
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
};

/**
 * Resolve an image reference against its HTML's location.
 * When baseDir is set, absolute http(s) URLs are mapped to local files by pathname
 * when those files exist (local-first for folder audits).
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

  // Remote page audits: resolve relative refs against the page URL first.
  const urlBase = ctx.sourceUrl ?? ctx.baseUrl;
  if (urlBase) {
    try {
      return { resolved: new URL(reference, urlBase).toString(), external: true };
    } catch {
      // fall through to filesystem
    }
  }

  // Root-relative paths anchor at the folder root, not the HTML file's directory.
  if (reference.startsWith("/") && ctx.baseDir) {
    const resolved = path.resolve(ctx.baseDir, "." + reference);
    return { resolved, external: false, localPath: resolved };
  }

  const dirBase = ctx.sourceFile ? path.dirname(ctx.sourceFile) : ctx.baseDir;
  if (dirBase) {
    const resolved = path.resolve(dirBase, reference);
    return { resolved, external: false, localPath: resolved };
  }

  return { resolved: reference, external: false };
}

/**
 * Map https://host/path/to/img.png → baseDir/path/to/img.png when the file exists.
 * Also tries baseDir/public/<pathname> for Vite-style layouts.
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
