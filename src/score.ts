import type { CheckResult, ImageAudit, PageStatus, SocialMeta, Warning } from "./types.js";
import {
  isDataUrl,
  isLocalhostUrl,
  isRelativeOrPathOnly,
  isRelativeReference,
  MAX_IMAGE_ASPECT,
  MIN_IMAGE_ASPECT,
  RECOMMENDED_IMAGE_HEIGHT,
  RECOMMENDED_IMAGE_WIDTH,
} from "./utils.js";

const VALID_TWITTER_CARDS = new Set(["summary", "summary_large_image", "app", "player"]);

export const DUPLICATE_KEYS = [
  ["openGraph", "title"],
  ["openGraph", "description"],
  ["openGraph", "image"],
  ["twitter", "card"],
  ["links", "canonical"],
] as const satisfies ReadonlyArray<readonly ["openGraph" | "twitter" | "links", string]>;

export type ScoreOptions = {
  /** True when image validation was skipped (--no-images or offline remote image). */
  imagesSkipped?: boolean;
};

export function findDuplicateCoreTags(meta: SocialMeta): string[] {
  const dupes: string[] = [];
  for (const [bucket, key] of DUPLICATE_KEYS) {
    if ((meta.raw[bucket][key]?.length ?? 0) > 1) {
      dupes.push(bucket === "links" ? key : `${bucket === "openGraph" ? "og" : "twitter"}:${key}`);
    }
  }
  return dupes;
}

export function hasDuplicateCoreTags(meta: SocialMeta): boolean {
  return findDuplicateCoreTags(meta).length > 0;
}

export function isValidTwitterCard(value: string | null | undefined): boolean {
  if (!value) return false;
  return VALID_TWITTER_CARDS.has(value.trim().toLowerCase());
}

/**
 * Score a page out of 100 based on metadata completeness, production URL hygiene,
 * and image validation. Skipped checks (e.g. --no-images or offline remote images)
 * are excluded from the denominator instead of counted as failures.
 */
export function scorePage(
  meta: SocialMeta,
  image: ImageAudit | null,
  options: ScoreOptions = {},
): { score: number; checks: CheckResult[] } {
  const og = meta.raw.openGraph;
  const hasOgTitle = !!og["title"]?.[0];
  const hasFallbackTitle = !hasOgTitle && !!meta.raw.titleTag;
  const hasOgDesc = !!og["description"]?.[0];
  const hasFallbackDesc = !hasOgDesc && !!meta.raw.metaDescription;
  const hasOgImage = !!(og["image"]?.[0] || og["image:url"]?.[0]);

  const offlineSkipped = !!image?.warnings.some((w) => w.code === "og-image-offline");
  const skipImages = !!options.imagesSkipped || offlineSkipped;

  const isSvg = !!image && (image.format === "svg" || image.contentType === "image/svg+xml");
  const isAvif = !!image && (image.format === "avif" || image.contentType === "image/avif");
  const decodedRaster = !!image && image.found && !!image.width && !!image.height && !isSvg;
  const imageBigEnough =
    decodedRaster &&
    image!.width! >= RECOMMENDED_IMAGE_WIDTH &&
    image!.height! >= RECOMMENDED_IMAGE_HEIGHT;
  const aspectOk =
    decodedRaster &&
    image!.height! > 0 &&
    image!.width! / image!.height! >= MIN_IMAGE_ASPECT &&
    image!.width! / image!.height! <= MAX_IMAGE_ASPECT;

  const productionUrlsPassed = hasProductionReadyUrls(meta);

  const checks: CheckResult[] = [
    hasOgTitle
      ? makeCheck("og-title", "og:title", "pass", 15, 15)
      : hasFallbackTitle
        ? makeCheck("og-title", "og:title (using <title> fallback)", "partial", 15, 8)
        : makeCheck("og-title", "og:title", "fail", 15, 0),

    hasOgDesc
      ? makeCheck("og-description", "og:description", "pass", 10, 10)
      : hasFallbackDesc
        ? makeCheck("og-description", "og:description (using meta description fallback)", "partial", 10, 5)
        : makeCheck("og-description", "og:description", "fail", 10, 0),

    makeCheck("og-image", "og:image", hasOgImage ? "pass" : "fail", 15, hasOgImage ? 15 : 0),

    skipImages
      ? makeCheck("image-readable", "Image loads as PNG, JPEG, or WebP", "skipped", 15, 0)
      : decodedRaster && !isAvif
        ? makeCheck("image-readable", "Image loads as PNG, JPEG, or WebP", "pass", 15, 15)
        : decodedRaster && isAvif
          ? makeCheck("image-readable", "Image loads (AVIF has limited platform support)", "partial", 15, 8)
          : makeCheck("image-readable", "Image loads as PNG, JPEG, or WebP", "fail", 15, 0),

    skipImages
      ? makeCheck(
          "image-dimensions",
          `Image at least ${RECOMMENDED_IMAGE_WIDTH}x${RECOMMENDED_IMAGE_HEIGHT}`,
          "skipped",
          10,
          0,
        )
      : makeCheck(
          "image-dimensions",
          `Image at least ${RECOMMENDED_IMAGE_WIDTH}x${RECOMMENDED_IMAGE_HEIGHT}`,
          imageBigEnough ? "pass" : "fail",
          10,
          imageBigEnough ? 10 : 0,
        ),

    skipImages
      ? makeCheck("image-aspect-ratio", "Image aspect ratio near 1.91:1", "skipped", 5, 0)
      : makeCheck(
          "image-aspect-ratio",
          "Image aspect ratio near 1.91:1",
          aspectOk ? "pass" : "fail",
          5,
          aspectOk ? 5 : 0,
        ),

    makeCheck(
      "production-urls",
      "Production-ready https:// URLs",
      productionUrlsPassed ? "pass" : "fail",
      15,
      productionUrlsPassed ? 15 : 0,
    ),

    makeCheck(
      "twitter-card",
      "Valid twitter:card",
      isValidTwitterCard(meta.twitterCard) ? "pass" : "fail",
      5,
      isValidTwitterCard(meta.twitterCard) ? 5 : 0,
    ),

    makeCheck("canonical", "Canonical link", meta.canonical ? "pass" : "fail", 5, meta.canonical ? 5 : 0),

    makeCheck(
      "no-duplicate-core-tags",
      "No duplicate core tags",
      !hasDuplicateCoreTags(meta) ? "pass" : "fail",
      5,
      !hasDuplicateCoreTags(meta) ? 5 : 0,
    ),
  ];

  let possible = 0;
  let earned = 0;
  for (const c of checks) {
    if (c.status === "skipped") continue;
    possible += c.weight;
    earned += c.earned;
  }

  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  return { score, checks };
}

function makeCheck(
  id: string,
  label: string,
  status: CheckResult["status"],
  weight: number,
  earned: number,
): CheckResult {
  return { id, label, passed: status === "pass", status, weight, earned };
}

function hasProductionReadyUrls(meta: SocialMeta): boolean {
  const imageUrls = [
    ...(meta.raw.openGraph["image"] ?? []),
    ...(meta.raw.openGraph["image:url"] ?? []),
    ...(meta.raw.twitter["image"] ?? []),
  ];

  const hasAnyUrl = !!(meta.url || meta.canonical || imageUrls.length > 0);
  if (!hasAnyUrl) return false;

  if (meta.url && (isLocalhostUrl(meta.url) || isRelativeOrPathOnly(meta.url))) return false;
  if (meta.canonical && (isLocalhostUrl(meta.canonical) || isRelativeOrPathOnly(meta.canonical))) {
    return false;
  }

  for (const u of imageUrls) {
    if (isRelativeReference(u) || isLocalhostUrl(u) || u.startsWith("http://") || isDataUrl(u)) {
      return false;
    }
  }

  return true;
}

export function statusFromScore(score: number): PageStatus {
  if (score >= 90) return "pass";
  if (score >= 70) return "warn";
  return "fail";
}

/** Derive page status from score and warnings: any error-level warning prevents "pass". */
export function pageStatus(score: number, warnings: Warning[]): PageStatus {
  const base = statusFromScore(score);
  if (base === "pass" && warnings.some((w) => w.severity === "error")) {
    return "warn";
  }
  return base;
}
