import fs from "node:fs/promises";
import sharp from "sharp";
import mime from "mime-types";
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
} from "./utils.js";
import { VERSION } from "./version.js";

export type ValidateImageOptions = {
  baseUrl?: string;
  baseDir?: string;
  sourceUrl?: string;
  sourceFile?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Resolve an og:image / twitter:image reference, fetch it, and probe its dimensions. */
export async function validateImage(
  source: string,
  options: ValidateImageOptions = {},
): Promise<ImageAudit> {
  const warnings: Warning[] = [];

  if (isRelativeReference(source)) {
    warnings.push({
      severity: "warning",
      code: "og-image-relative",
      message: `og:image is relative ("${source}"). Use an absolute URL for production.`,
    });
  }

  // Insecure http (mixed content risk for crawlers / browsers)
  if (typeof source === "string" && source.startsWith("http://")) {
    warnings.push({
      severity: "warning",
      code: "og-image-insecure",
      message: `og:image uses http:// ("${source}"). Use https:// to avoid mixed-content blocks on secure pages.`,
    });
  }

  const { resolved, external } = resolveReference(source, options);

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
      message: "og:image is a data URI. Skipping dimension validation.",
    });
    audit.found = true;
    return audit;
  }

  const buffer = await loadImageBuffer(resolved, external, options, warnings);
  if (!buffer) return audit;

  audit.found = true;
  audit.sizeBytes = buffer.length;
  audit.contentType = mime.lookup(resolved.split("?")[0] || "") || null;

  try {
    const meta = await sharp(buffer).metadata();
    audit.width = meta.width ?? null;
    audit.height = meta.height ?? null;
    audit.format = meta.format ?? null;
    if (meta.format) {
      audit.contentType = `image/${meta.format === "jpg" ? "jpeg" : meta.format}`;
    }
  } catch {
    warnings.push({
      severity: "error",
      code: "og-image-unreadable",
      message: "og:image could not be decoded.",
    });
  }

  if (audit.contentType && !audit.contentType.startsWith("image/")) {
    warnings.push({
      severity: "error",
      code: "og-image-bad-content-type",
      message: `og:image content type is "${audit.contentType}", expected image/*.`,
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
      message: `og:image is ${audit.width}x${audit.height}. Recommended: ${RECOMMENDED_IMAGE_WIDTH}x${RECOMMENDED_IMAGE_HEIGHT}.`,
    });
  }

  if (audit.sizeBytes !== null && audit.sizeBytes > MAX_IMAGE_BYTES) {
    warnings.push({
      severity: "warning",
      code: "og-image-too-large",
      message: `og:image is ${formatBytes(audit.sizeBytes)}. Recommended max: 5 MB.`,
    });
  }

  return audit;
}

async function loadImageBuffer(
  resolved: string,
  external: boolean,
  options: ValidateImageOptions,
  warnings: Warning[],
): Promise<Buffer | null> {
  if (external && isHttpUrl(resolved)) {
    try {
      return await fetchImageBuffer(resolved, options);
    } catch (err) {
      warnings.push({
        severity: "error",
        code: "og-image-not-found",
        message: `og:image could not be fetched (${(err as Error).message}).`,
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
        message: `og:image is not a file: ${resolved}`,
      });
      return null;
    }
    return await fs.readFile(resolved);
  } catch {
    warnings.push({
      severity: "error",
      code: "og-image-not-found",
      message: `og:image not found at ${resolved}.`,
    });
    return null;
  }
}

async function fetchImageBuffer(
  url: string,
  options: ValidateImageOptions,
): Promise<Buffer> {
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
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
