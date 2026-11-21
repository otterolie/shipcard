import fs from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import type { ImageAudit, Warning } from "./types.js";
import {
  findFileElsewhere,
  formatBytes,
  isDataUrl,
  isHttpUrl,
  isLocalhostUrl,
  isRelativeReference,
  resolveReference,
  stripQueryAndHash,
  MAX_IMAGE_BYTES,
  RECOMMENDED_IMAGE_HEIGHT,
  RECOMMENDED_IMAGE_WIDTH,
  type ResolveContext,
} from "./utils.js";
import { VERSION } from "./version.js";

const MAX_FETCH_BYTES = 20 * 1024 * 1024;

export type ImageProbeResult = {
  found: boolean;
  contentType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  format: string | null;
  decodeFailed?: boolean;
  errorKind?: "fetch-failed" | "not-file" | "not-found" | "too-large-aborted";
  errorDetail?: string;
};

export type ImageProbeCache = Map<string, Promise<ImageProbeResult>>;

export type ValidateImageOptions = ResolveContext & {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  label?: string;
  offline?: boolean;
  cache?: ImageProbeCache;
};

/** Resolve an og:image / twitter:image reference, load it, and read its dimensions. */
export async function validateImage(
  source: string,
  options: ValidateImageOptions = {},
): Promise<ImageAudit> {
  const label = options.label ?? "og:image";
  const warnings: Warning[] = [];

  if (isRelativeReference(source)) {
    warnings.push({
      severity: "warning",
      code: "og-image-relative",
      message: `${label} is relative ("${source}"). Use an absolute https:// URL in production.`,
    });
  }

  if (isLocalhostUrl(source)) {
    warnings.push({
      severity: "warning",
      code: "og-image-localhost",
      message: `${label} points to localhost ("${source}").`,
    });
  } else if (source.startsWith("http://")) {
    warnings.push({
      severity: "warning",
      code: "og-image-insecure",
      message: `${label} uses http:// ("${source}"). Use https:// to avoid mixed-content blocks.`,
    });
  }

  const { resolved, external } = resolveReference(source, options);

  if (!external && isHttpUrl(source)) {
    warnings.push({
      severity: "info",
      code: "og-image-local-map",
      message: `${label} URL maps to local file ${resolved}.`,
    });
  }

  if (external && isHttpUrl(source) && options.baseDir && !options.offline) {
    const host = safeHost(source);
    warnings.push({
      severity: "info",
      code: "og-image-external-host",
      message: host
        ? `${label} points to external host ${host} (fetched live, not from this folder). Use --offline to skip remote fetches.`
        : `${label} is a remote URL (fetched live, not from this folder). Use --offline to skip remote fetches.`,
    });
  }

  const audit: ImageAudit = {
    source,
    resolvedSource: resolved,
    found: false,
    external,
    contentType: null,
    width: null,
    height: null,
    sizeBytes: null,
    format: null,
    warnings,
  };

  if (isDataUrl(resolved)) {
    warnings.push({
      severity: "warning",
      code: "og-image-data-uri",
      message: `${label} is a data URI. Social crawlers require an http(s) image URL.`,
    });
    return audit;
  }

  if (external && isHttpUrl(resolved) && options.offline) {
    const host = safeHost(resolved);
    warnings.push({
      severity: "warning",
      code: "og-image-offline",
      message: host
        ? `${label} points to ${host} with no matching file in this folder. Skipped live fetch (--offline).`
        : `${label} is remote with no matching local file. Skipped live fetch (--offline).`,
    });
    if (options.searchRoot) {
      const pathname = safePathname(resolved);
      const hint = pathname && (await elsewhereWarning(label, pathname, options.searchRoot, options.baseDir));
      if (hint) warnings.push(hint);
    }
    return audit;
  }

  const probe = await probeWithCache(resolved, external, options);

  if (!probe.found) {
    if (probe.errorKind === "too-large-aborted") {
      audit.found = true;
      audit.sizeBytes = probe.sizeBytes;
      audit.contentType = probe.contentType;
      warnings.push({
        severity: "warning",
        code: "og-image-too-large",
        message: `${label} exceeds ${formatBytes(MAX_FETCH_BYTES)} (recommended max: 5 MB). Download skipped.`,
      });
      return audit;
    }

    if (probe.errorKind === "fetch-failed") {
      const host = safeHost(resolved);
      warnings.push({
        severity: "error",
        code: "og-image-not-found",
        message: host
          ? `${label} could not be fetched from ${host} (${probe.errorDetail}). If this site is not deployed yet, use --offline or --no-images.`
          : `${label} could not be fetched (${probe.errorDetail}).`,
      });
    } else if (probe.errorKind === "not-file") {
      warnings.push({
        severity: "error",
        code: "og-image-not-found",
        message: `${label} is not a file: ${resolved}`,
      });
    } else {
      warnings.push({
        severity: "error",
        code: "og-image-not-found",
        message: `${label} not found at ${resolved}.`,
      });
      if (!external && source.startsWith("/") && options.searchRoot) {
        const hint = await elsewhereWarning(
          label,
          stripQueryAndHash(source),
          options.searchRoot,
          options.baseDir,
        );
        if (hint) warnings.push(hint);
      }
    }
    return audit;
  }

  audit.found = true;
  audit.sizeBytes = probe.sizeBytes;
  audit.contentType = probe.contentType;
  audit.width = probe.width;
  audit.height = probe.height;
  audit.format = probe.format;

  if (probe.decodeFailed) {
    warnings.push({
      severity: "error",
      code: "og-image-unreadable",
      message: `${label} could not be decoded.`,
    });
  }

  if (audit.contentType && !audit.contentType.startsWith("image/")) {
    warnings.push({
      severity: "error",
      code: "og-image-bad-content-type",
      message: `${label} content type is "${audit.contentType}", expected image/*.`,
    });
  }

  if (audit.format === "svg" || audit.contentType === "image/svg+xml") {
    warnings.push({
      severity: "warning",
      code: "og-image-svg",
      message: `${label} is an SVG. Most social platforms require PNG, JPEG, or WebP.`,
    });
  }

  if (
    audit.width !== null &&
    audit.height !== null &&
    (audit.width < RECOMMENDED_IMAGE_WIDTH || audit.height < RECOMMENDED_IMAGE_HEIGHT)
  ) {
    warnings.push({
      severity: "warning",
      code: "og-image-too-small",
      message: `${label} is ${audit.width}x${audit.height}. Recommended: ${RECOMMENDED_IMAGE_WIDTH}x${RECOMMENDED_IMAGE_HEIGHT}.`,
    });
  }

  if (audit.sizeBytes !== null && audit.sizeBytes > MAX_IMAGE_BYTES) {
    warnings.push({
      severity: "warning",
      code: "og-image-too-large",
      message: `${label} is ${formatBytes(audit.sizeBytes)}. Recommended max: 5 MB.`,
    });
  }

  return audit;
}

function probeWithCache(
  resolved: string,
  external: boolean,
  options: ValidateImageOptions,
): Promise<ImageProbeResult> {
  const key = `${external ? "ext" : "local"}:${resolved}`;
  const cached = options.cache?.get(key);
  if (cached) return cached;

  const promise = probeImage(resolved, external, options);
  options.cache?.set(key, promise);
  return promise;
}

async function probeImage(
  resolved: string,
  external: boolean,
  options: ValidateImageOptions,
): Promise<ImageProbeResult> {
  const loaded = await loadImageBuffer(resolved, external, options);
  if ("errorKind" in loaded) {
    return {
      found: false,
      contentType: loaded.contentType ?? null,
      width: null,
      height: null,
      sizeBytes: loaded.sizeBytes ?? null,
      format: null,
      errorKind: loaded.errorKind,
      errorDetail: loaded.errorDetail,
    };
  }

  let width: number | null = null;
  let height: number | null = null;
  let format: string | null = null;
  let contentType = loaded.contentType;
  let decodeFailed = false;

  try {
    const meta = imageSize(loaded.buffer);
    width = meta.width ?? null;
    height = meta.height ?? null;
    format = meta.type ?? null;
    if (meta.type && !contentType) {
      if (meta.type === "jpg") contentType = "image/jpeg";
      else if (meta.type === "svg") contentType = "image/svg+xml";
      else contentType = `image/${meta.type}`;
    }
  } catch {
    decodeFailed = true;
  }

  return {
    found: true,
    contentType,
    width,
    height,
    sizeBytes: loaded.buffer.length,
    format,
    decodeFailed,
  };
}

async function elsewhereWarning(
  label: string,
  relativePath: string,
  searchRoot: string,
  skipDir?: string,
): Promise<Warning | null> {
  const clean = relativePath.replace(/^\/+/, "");
  if (!clean) return null;
  const found = await findFileElsewhere(searchRoot, clean, skipDir);
  if (!found) return null;
  const display = "./" + path.relative(searchRoot, found).split(path.sep).join("/");
  return {
    severity: "warning",
    code: "og-image-found-elsewhere",
    message: `${label} was not found here, but exists at ${display}. Try pointing shipcard at that subfolder.`,
  };
}

function safePathname(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

type LoadResult =
  | { buffer: Buffer; contentType: string | null }
  | {
      errorKind: "fetch-failed" | "not-file" | "not-found" | "too-large-aborted";
      errorDetail?: string;
      sizeBytes?: number | null;
      contentType?: string | null;
    };

async function loadImageBuffer(
  resolved: string,
  external: boolean,
  options: ValidateImageOptions,
): Promise<LoadResult> {
  if (external && isHttpUrl(resolved)) {
    try {
      return await fetchImageBuffer(resolved, options);
    } catch (err) {
      return { errorKind: "fetch-failed", errorDetail: (err as Error).message };
    }
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { errorKind: "not-file" };
    return { buffer: await fs.readFile(resolved), contentType: null };
  } catch {
    return { errorKind: "not-found" };
  }
}

async function fetchImageBuffer(
  url: string,
  options: ValidateImageOptions,
): Promise<LoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": `shipcard/${VERSION}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || null;

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_BYTES) {
      controller.abort();
      return { errorKind: "too-large-aborted", sizeBytes: declaredLength, contentType };
    }

    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FETCH_BYTES) {
          controller.abort();
          return { errorKind: "too-large-aborted", sizeBytes: total, contentType };
        }
        chunks.push(value);
      }
      return { buffer: Buffer.concat(chunks), contentType };
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) {
      return { errorKind: "too-large-aborted", sizeBytes: buf.length, contentType };
    }
    return { buffer: buf, contentType };
  } finally {
    clearTimeout(timer);
  }
}
