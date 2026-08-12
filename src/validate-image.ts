import fs from "node:fs/promises";
import { imageSize } from "image-size";
import type { ImageAudit, Warning } from "./types.js";
import {
  formatBytes,
  isDataUrl,
  isHttpUrl,
  isRelativeReference,
  resolveReference,
  MAX_IMAGE_BYTES,
  RECOMMENDED_IMAGE_HEIGHT,
  RECOMMENDED_IMAGE_WIDTH,
  type ResolveContext,
} from "./utils.js";
import { VERSION } from "./version.js";

export type ValidateImageOptions = ResolveContext & {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Label used in warning messages (default "og:image"). */
  label?: string;
  /** Never fetch remote images; only local files / local path maps. */
  offline?: boolean;
};

/** Resolve an og:image / twitter:image reference, load it, and probe its dimensions. */
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
      message: `${label} is relative ("${source}"). Use an absolute URL for production.`,
    });
  }

  if (source.startsWith("http://")) {
    warnings.push({
      severity: "warning",
      code: "og-image-insecure",
      message: `${label} uses http:// ("${source}"). Use https:// to avoid mixed-content blocks on secure pages.`,
    });
  }

  const { resolved, external } = resolveReference(source, options);

  // Absolute production URL was mapped to a local file — good for local preflight.
  if (!external && isHttpUrl(source)) {
    warnings.push({
      severity: "info",
      code: "og-image-local-map",
      message: `${label} URL maps to a local file (${resolved}). Validating on disk.`,
    });
  }

  // Folder audit: absolute URL did not map to a local file
  if (external && isHttpUrl(source) && options.baseDir && !options.offline) {
    const host = safeHost(source);
    warnings.push({
      severity: "info",
      code: "og-image-external-host",
      message: host
        ? `${label} resolves to an external host (${host}) — this check hits that live URL, not a file in this folder. Use --offline to skip live fetches.`
        : `${label} is an absolute remote URL — this check hits the live URL, not a file in this folder. Use --offline to skip live fetches.`,
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
      severity: "info",
      code: "og-image-data-uri",
      message: `${label} is a data URI. Skipping dimension validation.`,
    });
    audit.found = true;
    return audit;
  }

  if (external && isHttpUrl(resolved) && options.offline) {
    const host = safeHost(resolved);
    warnings.push({
      severity: "warning",
      code: "og-image-offline",
      message: host
        ? `${label} points at ${host} with no matching file in this folder. Skipped live fetch (--offline).`
        : `${label} is remote with no matching local file. Skipped live fetch (--offline).`,
    });
    return audit;
  }

  const loaded = await loadImageBuffer(resolved, external, options, warnings, label);
  if (!loaded) return audit;

  audit.found = true;
  audit.sizeBytes = loaded.buffer.length;
  audit.contentType = loaded.contentType;

  try {
    const meta = imageSize(loaded.buffer);
    audit.width = meta.width ?? null;
    audit.height = meta.height ?? null;
    audit.format = meta.type ?? null;
    if (meta.type && !audit.contentType) {
      audit.contentType = `image/${meta.type === "jpg" ? "jpeg" : meta.type}`;
    }
  } catch {
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

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function loadImageBuffer(
  resolved: string,
  external: boolean,
  options: ValidateImageOptions,
  warnings: Warning[],
  label: string,
): Promise<{ buffer: Buffer; contentType: string | null } | null> {
  if (external && isHttpUrl(resolved)) {
    try {
      return await fetchImageBuffer(resolved, options);
    } catch (err) {
      const host = safeHost(resolved);
      const detail = (err as Error).message;
      warnings.push({
        severity: "error",
        code: "og-image-not-found",
        message: host
          ? `${label} could not be fetched from ${host} (${detail}). If this site is not deployed yet, use --offline or --no-images.`
          : `${label} could not be fetched (${detail}).`,
      });
      return null;
    }
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      warnings.push({
        severity: "error",
        code: "og-image-not-found",
        message: `${label} is not a file: ${resolved}`,
      });
      return null;
    }
    return { buffer: await fs.readFile(resolved), contentType: null };
  } catch {
    warnings.push({
      severity: "error",
      code: "og-image-not-found",
      message: `${label} not found at ${resolved}.`,
    });
    return null;
  }
}

async function fetchImageBuffer(
  url: string,
  options: ValidateImageOptions,
): Promise<{ buffer: Buffer; contentType: string | null }> {
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
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
  } finally {
    clearTimeout(timer);
  }
}
