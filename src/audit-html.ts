import type { AuditOptions, PageReport, SocialMeta, Warning } from "./types.js";
import { extractMeta } from "./extract-meta.js";
import { findDuplicateCoreTags, scorePage, statusFromScore } from "./score.js";
import { validateImage } from "./validate-image.js";
import { platformPreviews } from "./platforms.js";
import { isLocalhostUrl } from "./utils.js";

export type AuditHtmlOptions = AuditOptions & {
  /** Display label for this page in the report (URL or file path). */
  source: string;
  /** Logical path: a URL for URL targets, "/sub/page.html" for folder targets. */
  path: string;
  sourceFile?: string;
  sourceUrl?: string;
};

/** Audit a single HTML document and produce a scored PageReport. */
export async function auditHtml(html: string, options: AuditHtmlOptions): Promise<PageReport> {
  const meta = extractMeta(html);
  const warnings = collectMetaWarnings(meta);

  let image = null;
  if (meta.image && options.validateImages !== false) {
    image = await validateImage(meta.image, {
      baseUrl: options.baseUrl,
      baseDir: options.baseDir,
      sourceUrl: options.sourceUrl,
      sourceFile: options.sourceFile,
      timeoutMs: options.timeoutMs,
    });
    warnings.push(...image.warnings);
  }

  if (isLocalhostUrl(meta.url)) {
    warnings.push({
      severity: "warning",
      code: "og-url-localhost",
      message: `og:url points to localhost ("${meta.url}").`,
    });
  }
  if (isLocalhostUrl(meta.canonical)) {
    warnings.push({
      severity: "warning",
      code: "canonical-localhost",
      message: `canonical points to localhost ("${meta.canonical}").`,
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
    checks,
    warnings,
    platforms,
  };
}

function collectMetaWarnings(meta: SocialMeta): Warning[] {
  const w: Warning[] = [];
  const og = meta.raw.openGraph;

  if (!og["title"]?.[0]) w.push(missing("warning", "missing-og-title", "og:title"));
  if (!og["description"]?.[0]) w.push(missing("warning", "missing-og-description", "og:description"));
  if (!og["image"]?.[0]) w.push(missing("error", "missing-og-image", "og:image"));
  if (!meta.twitterCard) w.push(missing("warning", "missing-twitter-card", "twitter:card"));
  if (!meta.canonical) w.push(missing("info", "missing-canonical", "canonical link"));

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
