import type { CheckResult, ImageAudit, PageStatus, SocialMeta } from "./types.js";
import { RECOMMENDED_IMAGE_HEIGHT, RECOMMENDED_IMAGE_WIDTH } from "./utils.js";

/** The raw-bucket keys that should appear at most once per page. */
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

/** Apply the weighted scoring model; returns per-check results and the total (0–100). */
export function scorePage(
  meta: SocialMeta,
  image: ImageAudit | null,
): { score: number; checks: CheckResult[] } {
  const og = meta.raw.openGraph;
  const imageReadable = !!image && image.found && !!image.width && !!image.height;
  const imageBigEnough =
    imageReadable &&
    image!.width! >= RECOMMENDED_IMAGE_WIDTH &&
    image!.height! >= RECOMMENDED_IMAGE_HEIGHT;

  const checks: CheckResult[] = [
    { id: "title", label: "Title found", passed: !!meta.title, weight: 10 },
    { id: "description", label: "Description found", passed: !!meta.description, weight: 10 },
    { id: "og-title", label: "og:title found", passed: !!og["title"]?.[0], weight: 10 },
    { id: "og-description", label: "og:description found", passed: !!og["description"]?.[0], weight: 10 },
    { id: "og-image", label: "og:image found", passed: !!og["image"]?.[0], weight: 20 },
    { id: "image-readable", label: "Image fetchable / readable", passed: imageReadable, weight: 15 },
    {
      id: "image-dimensions",
      label: `Image at least ${RECOMMENDED_IMAGE_WIDTH}x${RECOMMENDED_IMAGE_HEIGHT}`,
      passed: imageBigEnough,
      weight: 10,
    },
    { id: "twitter-card", label: "twitter:card found", passed: !!meta.twitterCard, weight: 5 },
    { id: "canonical", label: "Canonical link found", passed: !!meta.canonical, weight: 5 },
    { id: "no-duplicate-core-tags", label: "No duplicate core tags", passed: !hasDuplicateCoreTags(meta), weight: 5 },
  ];

  const score = checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0);
  return { score, checks };
}

export function statusFromScore(score: number): PageStatus {
  if (score >= 90) return "ready";
  if (score >= 70) return "warning";
  return "fail";
}
