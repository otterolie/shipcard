import type { AuditOptions, ImageAudit, PageReport, SocialMeta, Warning } from "./types.js";
import { extractMeta } from "./extract-meta.js";
import { findDuplicateCoreTags, scorePage, statusFromScore } from "./score.js";
import { validateImage } from "./validate-image.js";
import { platformPreviews } from "./platforms.js";
import { isLocalhostUrl, isRelativeOrPathOnly } from "./utils.js";

export type AuditHtmlOptions = AuditOptions & {
  /** Display label for this page in the report (URL or file path). */
  source: string;
  /** Logical path: a URL for URL targets, "/sub/page.html" for folder targets. */
  path: string;
  sourceFile?: string;
  sourceUrl?: string;
  /** Folder originally passed to the scan, for the "found elsewhere in this tree" diagnostic. */
  searchRoot?: string;
};

/** Audit a single HTML document and produce a scored PageReport. */
export async function auditHtml(html: string, options: AuditHtmlOptions): Promise<PageReport> {
  const meta = extractMeta(html);
  const warnings = collectMetaWarnings(meta);

  const resolveOpts = {
    baseUrl: options.baseUrl,
    baseDir: options.baseDir,
    sourceUrl: options.sourceUrl,
    sourceFile: options.sourceFile,
    searchRoot: options.searchRoot,
    timeoutMs: options.timeoutMs,
    offline: options.offline,
  };

  let images: ImageAudit[] = [];
  let image: ImageAudit | null = null;

  if (options.validateImages !== false) {
    const sources = collectImageSources(meta);
    for (const { url, label } of sources) {
      images.push(await validateImage(url, { ...resolveOpts, label }));
    }
    image = images[0] ?? null;
    for (const img of images) {
      warnings.push(...img.warnings);
    }

    // Declared og:image:width/height vs real probe (primary image)
    if (image?.found && image.width && image.height) {
      const declaredW = parseInt(meta.raw.openGraph["image:width"]?.[0] ?? "", 10);
      const declaredH = parseInt(meta.raw.openGraph["image:height"]?.[0] ?? "", 10);
      if (
        Number.isFinite(declaredW) &&
        Number.isFinite(declaredH) &&
        (declaredW !== image.width || declaredH !== image.height)
      ) {
        const smaller = image.width < declaredW || image.height < declaredH;
        const hint = smaller
          ? " The file is smaller than declared — likely capped by a smaller source image; check your image pipeline's upscale/enlargement setting."
          : " The file is larger than declared — update the width/height meta tags to match.";
        warnings.push({
          severity: "warning",
          code: "og-image-dimensions-mismatch",
          message: `og:image:width/height is ${declaredW}x${declaredH} but the file is ${image.width}x${image.height}.${hint}`,
        });
      }
    }
  }

  if (isLocalhostUrl(meta.url)) {
    warnings.push({
      severity: "warning",
      code: "og-url-localhost",
      message: `og:url points to localhost ("${meta.url}").`,
    });
  } else if (isRelativeOrPathOnly(meta.url)) {
    warnings.push({
      severity: "warning",
      code: "og-url-relative",
      message: `og:url is not an absolute URL ("${meta.url}"). Crawlers need https://…`,
    });
  }

  if (isLocalhostUrl(meta.canonical)) {
    warnings.push({
      severity: "warning",
      code: "canonical-localhost",
      message: `canonical points to localhost ("${meta.canonical}").`,
    });
  } else if (isRelativeOrPathOnly(meta.canonical)) {
    warnings.push({
      severity: "warning",
      code: "canonical-relative",
      message: `canonical is not an absolute URL ("${meta.canonical}"). Prefer https://…`,
    });
  }

  const { score, checks } = scorePage(meta, image);
  const platforms = platformPreviews(meta, image);

  return {
    path: options.path,
    source: options.source,
    score,
    status: statusFromScore(score),
    meta,
    image,
    images,
    checks,
    warnings,
    platforms,
  };
}

/** Unique social image URLs to validate, primary first. */
function collectImageSources(meta: SocialMeta): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();

  const push = (url: string | undefined, label: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label });
  };

  for (const url of meta.raw.openGraph["image"] ?? []) {
    push(url, "og:image");
  }
  for (const url of meta.raw.twitter["image"] ?? []) {
    push(url, "twitter:image");
  }

  return out;
}

function collectMetaWarnings(meta: SocialMeta): Warning[] {
  const w: Warning[] = [];
  const og = meta.raw.openGraph;

  if (!og["title"]?.[0]) w.push(missing("warning", "missing-og-title", "og:title"));
  if (!og["description"]?.[0]) w.push(missing("warning", "missing-og-description", "og:description"));
  if (!og["image"]?.[0]) w.push(missing("error", "missing-og-image", "og:image"));
  if (!meta.twitterCard) w.push(missing("warning", "missing-twitter-card", "twitter:card"));
  if (!meta.canonical) w.push(missing("info", "missing-canonical", "canonical link"));

  if (og["image"]?.[0] && !og["image:alt"]?.[0]) {
    w.push({
      severity: "info",
      code: "og-image-alt-missing",
      message: "og:image:alt is missing. Accessibility and some platforms benefit from a short alt text.",
    });
  }

  const dupes = findDuplicateCoreTags(meta);
  if (dupes.length > 0) {
    w.push({
      severity: "warning",
      code: "duplicate-core-tags",
      message: `Duplicate core tags detected: ${dupes.join(", ")}.`,
    });
  }
  return w;
}

function missing(severity: Warning["severity"], code: string, name: string): Warning {
  return { severity, code, message: `${name} is missing.` };
}
