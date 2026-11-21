import type { AuditOptions, ImageAudit, PageReport, SocialMeta, Warning } from "./types.js";
import { extractMetaWithStats } from "./extract-meta.js";
import { findDuplicateCoreTags, scorePage, statusFromScore } from "./score.js";
import { validateImage, type ImageProbeCache } from "./validate-image.js";
import { platformPreviews } from "./platforms.js";
import {
  formatBytes,
  isLocalhostUrl,
  isRelativeOrPathOnly,
  LATE_META_BYTES,
} from "./utils.js";

export type AuditHtmlOptions = AuditOptions & {
  source: string;
  path: string;
  sourceFile?: string;
  sourceUrl?: string;
  searchRoot?: string;
  imageCache?: ImageProbeCache;
  fetchImpl?: typeof fetch;
};

/** Audit a single HTML document and produce a scored PageReport. */
export async function auditHtml(html: string, options: AuditHtmlOptions): Promise<PageReport> {
  const { meta, lastSocialTagByte } = extractMetaWithStats(html);
  const warnings = collectMetaWarnings(meta);

  if (lastSocialTagByte > LATE_META_BYTES) {
    warnings.push({
      severity: "warning",
      code: "meta-too-late",
      message: `Social meta tags appear at ${formatBytes(lastSocialTagByte)} into the HTML. Crawlers like Slack, WhatsApp, and Discord may truncate responses past 50-256 KB; place social tags near the top of <head>.`,
    });
  }

  const resolveOpts = {
    baseUrl: options.baseUrl,
    baseDir: options.baseDir,
    sourceUrl: options.sourceUrl,
    sourceFile: options.sourceFile,
    searchRoot: options.searchRoot,
    timeoutMs: options.timeoutMs,
    offline: options.offline,
    cache: options.imageCache,
    fetchImpl: options.fetchImpl,
  };

  let images: ImageAudit[] = [];
  let image: ImageAudit | null = null;

  if (options.validateImages !== false) {
    const sources = collectImageSources(meta);
    const isSummaryTwitterCard = meta.twitterCard?.toLowerCase() === "summary";
    images = await Promise.all(
      sources.map(({ url, label }) =>
        validateImage(url, {
          ...resolveOpts,
          label,
          allowSquare: label === "twitter:image" && isSummaryTwitterCard,
        }),
      ),
    );
    image = images[0] ?? null;
    for (const img of images) {
      warnings.push(...img.warnings);
    }

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
          ? " The file is smaller than declared (check your image pipeline's upscale settings)."
          : " Update og:image:width and og:image:height to match the actual file.";
        warnings.push({
          severity: "warning",
          code: "og-image-dimensions-mismatch",
          message: `og:image:width/height is ${declaredW}x${declaredH} but the file is ${image.width}x${image.height}.${hint}`,
        });
      }
    }
  }

  checkUrlWarning(meta.url, "og:url", "og-url", warnings);
  checkUrlWarning(meta.canonical, "canonical", "canonical", warnings);

  const { score, checks } = scorePage(meta, image);
  const platforms = platformPreviews(meta, image, options.validateImages === false ? undefined : images);

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

function checkUrlWarning(
  value: string | null,
  label: string,
  codePrefix: string,
  warnings: Warning[],
): void {
  if (isLocalhostUrl(value)) {
    warnings.push({
      severity: "warning",
      code: `${codePrefix}-localhost`,
      message: `${label} points to localhost ("${value}").`,
    });
  } else if (isRelativeOrPathOnly(value)) {
    warnings.push({
      severity: "warning",
      code: `${codePrefix}-relative`,
      message: `${label} is not an absolute URL ("${value}"). Use an https:// URL.`,
    });
  }
}

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
  if (out.length === 0) {
    for (const url of meta.raw.openGraph["image:url"] ?? []) {
      push(url, "og:image");
    }
  }
  for (const url of meta.raw.twitter["image"] ?? []) {
    push(url, "twitter:image");
  }

  return out;
}

function collectMetaWarnings(meta: SocialMeta): Warning[] {
  const w: Warning[] = [];
  const og = meta.raw.openGraph;
  const hasOgImage = !!(og["image"]?.[0] || og["image:url"]?.[0]);

  if (!og["title"]?.[0]) w.push(missing("warning", "missing-og-title", "og:title"));
  if (!og["description"]?.[0]) w.push(missing("warning", "missing-og-description", "og:description"));
  if (!hasOgImage) w.push(missing("error", "missing-og-image", "og:image"));
  if (!meta.twitterCard) w.push(missing("warning", "missing-twitter-card", "twitter:card"));
  if (!meta.canonical) w.push(missing("info", "missing-canonical", "canonical link"));

  if (hasOgImage && !og["image:alt"]?.[0]) {
    w.push({
      severity: "info",
      code: "og-image-alt-missing",
      message: "og:image:alt is missing.",
    });
  }

  const dupes = findDuplicateCoreTags(meta);
  if (dupes.length > 0) {
    w.push({
      severity: "warning",
      code: "duplicate-core-tags",
      message: `Duplicate core tags: ${dupes.join(", ")}.`,
    });
  }
  return w;
}

function missing(severity: Warning["severity"], code: string, name: string): Warning {
  return { severity, code, message: `${name} is missing.` };
}
