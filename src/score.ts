import type { CheckResult, ImageAudit, PageStatus, SocialMeta } from "./types.js";
import { RECOMMENDED_IMAGE_HEIGHT, RECOMMENDED_IMAGE_WIDTH } from "./utils.js";

export const DUPLICATE_KEYS = [
  ["openGraph", "title"],
  ["openGraph", "description"],
  ["openGraph", "image"],
  ["twitter", "card"],
  ["links", "canonical"],
] as const satisfies ReadonlyArray<readonly ["openGraph" | "twitter" | "links", string]>;

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

/** Score a page out of 100 based on metadata completeness and image validation. */
export function scorePage(
  meta: SocialMeta,
  image: ImageAudit | null,
): { score: number; checks: CheckResult[] } {
  const og = meta.raw.openGraph;
  const hasOgImage = !!(og["image"]?.[0] || og["image:url"]?.[0]);
  const isRaster =
    !!image && image.format !== "svg" && image.contentType !== "image/svg+xml";
  const imageReadable = !!image && image.found && !!image.width && !!image.height && isRaster;
  const imageBigEnough =
    imageReadable &&
    image!.width! >= RECOMMENDED_IMAGE_WIDTH &&
    image!.height! >= RECOMMENDED_IMAGE_HEIGHT;

  const checks: CheckResult[] = [
    { id: "title", label: "Title", passed: !!meta.title, weight: 10 },
    { id: "description", label: "Description", passed: !!meta.description, weight: 10 },
    { id: "og-title", label: "og:title", passed: !!og["title"]?.[0], weight: 10 },
    { id: "og-description", label: "og:description", passed: !!og["description"]?.[0], weight: 10 },
    { id: "og-image", label: "og:image", passed: hasOgImage, weight: 20 },
    { id: "image-readable", label: "Image loads and decodes", passed: imageReadable, weight: 15 },
    {
      id: "image-dimensions",
      label: `Image at least ${RECOMMENDED_IMAGE_WIDTH}x${RECOMMENDED_IMAGE_HEIGHT}`,
      passed: imageBigEnough,
      weight: 10,
    },
    { id: "twitter-card", label: "twitter:card", passed: !!meta.twitterCard, weight: 5 },
    { id: "canonical", label: "Canonical link", passed: !!meta.canonical, weight: 5 },
    {
      id: "no-duplicate-core-tags",
      label: "No duplicate core tags",
      passed: !hasDuplicateCoreTags(meta),
      weight: 5,
    },
  ];

  const score = checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0);
  return { score, checks };
}

export function statusFromScore(score: number): PageStatus {
  if (score >= 90) return "pass";
  if (score >= 70) return "warn";
  return "fail";
}
