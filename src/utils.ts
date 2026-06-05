import { URL } from "node:url";
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

export type ResolveContext = {
  baseUrl?: string;
  baseDir?: string;
  sourceUrl?: string;
  sourceFile?: string;
};

/**
 * Resolve an image reference against its HTML's location. Returns an absolute URL
 * for URL-based audits and an absolute filesystem path for folder-based audits.
 */
export function resolveReference(
  reference: string,
  ctx: ResolveContext,
): { resolved: string; external: boolean } {
  if (isDataUrl(reference)) return { resolved: reference, external: false };
  if (reference.startsWith("//")) return { resolved: `https:${reference}`, external: true };
  if (isAbsoluteUrl(reference)) return { resolved: reference, external: true };

  const urlBase = ctx.sourceUrl ?? ctx.baseUrl;
  if (urlBase) {
    try {
      return { resolved: new URL(reference, urlBase).toString(), external: true };
    } catch {
      // The base URL is malformed; fall back to filesystem resolution below.
    }
  }

  // Root-relative paths anchor at the folder root, not the HTML file's directory.
  if (reference.startsWith("/") && ctx.baseDir) {
    return { resolved: path.resolve(ctx.baseDir, "." + reference), external: false };
  }

  const dirBase = ctx.sourceFile ? path.dirname(ctx.sourceFile) : ctx.baseDir;
  if (dirBase) {
    return { resolved: path.resolve(dirBase, reference), external: false };
  }

  return { resolved: reference, external: false };
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
