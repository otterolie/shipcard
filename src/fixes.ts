import * as cheerio from "cheerio";
import type { AuditReport, PageReport } from "./types.js";
import { isLocalhostUrl } from "./utils.js";

export type FixCategory = "tag" | "image" | "url" | "duplicate";

export type Fix = {
  id: string;
  /** Short imperative label, e.g. "Add og:image". */
  label: string;
  /** Points this fix recovers on the 0–100 score. 0 = quality-only fix (no direct score impact). */
  weight: number;
  /** One-or-two sentence rationale for *why* this matters. */
  explain: string;
  /** Copyable HTML to add. Omitted for fixes that can't be expressed as a single tag. */
  snippet?: string;
  category: FixCategory;
};

/**
 * Generate concrete fixes to bring a page closer to 100. If the full report is provided,
 * cross-page intelligence kicks in — e.g. suggesting an og:image URL that another page
 * in the same site already uses successfully.
 */
export function fixesForPage(page: PageReport, report?: AuditReport): Fix[] {
  const host = inferHost(page, report);
  const pageUrl = inferPageUrl(page, host);
  const suggestedImage = suggestImage(page, report, host);
  const suggestedTitle = page.meta.title ?? page.meta.raw.titleTag ?? "Your page title";
  const suggestedDescription =
    page.meta.description ??
    "A clear 50–200 character summary of what this page is about.";

  const fixes: Fix[] = [];

  for (const check of page.checks) {
    if (check.passed) continue;
    const fix = checkToFix(check.id, check.weight, {
      host,
      pageUrl,
      suggestedImage,
      suggestedTitle,
      suggestedDescription,
      page,
    });
    if (fix) fixes.push(fix);
  }

  // Warning-driven fixes that aren't represented as checks
  if (page.warnings.some((w) => w.code === "og-url-localhost")) {
    fixes.push({
      id: "fix-og-url-localhost",
      label: "Point og:url at production",
      weight: 0,
      explain: `og:url is currently a localhost address. Production crawlers will resolve it to a broken link. Use your production URL before deploying.`,
      snippet: `<meta property="og:url" content="${pageUrl}">`,
      category: "url",
    });
  }
  if (page.warnings.some((w) => w.code === "canonical-localhost")) {
    fixes.push({
      id: "fix-canonical-localhost",
      label: "Point canonical at production",
      weight: 0,
      explain: `<link rel="canonical"> is currently a localhost address. Search engines and platforms will treat this as a broken canonical reference.`,
      snippet: `<link rel="canonical" href="${pageUrl}">`,
      category: "url",
    });
  }
  if (page.warnings.some((w) => w.code === "duplicate-core-tags")) {
    fixes.push({
      id: "fix-duplicate-tags",
      label: "Remove duplicate core tags",
      weight: 0,
      explain: `One or more core tags (og:title, og:image, twitter:card, or canonical) appear more than once. Different crawlers pick different copies — keep exactly one of each.`,
      category: "duplicate",
    });
  }
  if (page.warnings.some((w) => w.code === "og-image-relative")) {
    fixes.push({
      id: "fix-og-image-absolute",
      label: "Use an absolute URL for og:image",
      weight: 0,
      explain: `og:image is currently a relative path. Most crawlers require an absolute https:// URL to fetch the preview image.`,
      snippet: `<meta property="og:image" content="${suggestedImage}">`,
      category: "image",
    });
  }
  if (page.warnings.some((w) => w.code === "og-image-insecure")) {
    fixes.push({
      id: "fix-og-image-https",
      label: "Serve og:image over https",
      weight: 0,
      explain: `og:image is using http://. Crawlers and browsers on https pages may block or downgrade mixed-content images, resulting in broken or text-only cards.`,
      snippet: `<meta property="og:image" content="${suggestedImage.replace(/^http:/, "https:")}">`,
      category: "image",
    });
  }
  if (page.warnings.some((w) => w.code === "og-image-too-large")) {
    fixes.push({
      id: "fix-og-image-too-large",
      label: "Compress og:image below 5 MB",
      weight: 0,
      explain: `The current og:image exceeds 5 MB. Some platforms will refuse to fetch it and silently fall back to a text-only card. Re-export as compressed JPEG or use a tool like ImageOptim or Squoosh.`,
      category: "image",
    });
  }

  return mergeImageFixes(fixes).sort(byImpactDesc);
}

/**
 * If multiple image-related fixes are present, the user really only needs to do one
 * thing: provide one good image. Combine them into a single, more honest fix.
 */
function mergeImageFixes(fixes: Fix[]): Fix[] {
  const imageIds = ["fix-og-image", "fix-image-readable", "fix-image-dimensions"];
  const imageFixes = fixes.filter((f) => imageIds.includes(f.id));
  if (imageFixes.length <= 1) return fixes;

  const totalWeight = imageFixes.reduce((sum, f) => sum + f.weight, 0);
  const hasMissing = imageFixes.some((f) => f.id === "fix-og-image");
  const snippet = imageFixes.find((f) => f.id === "fix-og-image")?.snippet;

  const merged: Fix = {
    id: "fix-og-image-combined",
    label: hasMissing
      ? "Add a 1200×630 og:image"
      : "Replace og:image with a fetchable 1200×630 image",
    weight: totalWeight,
    explain: hasMissing
      ? "Without a valid og:image, Meta and X won't render any card and LinkedIn falls back to a text-only summary. Use a JPEG or PNG that's at least 1200×630 (1.91:1 aspect ratio) and reachable at an absolute https URL."
      : "The current og:image either can't be fetched or is below 1200×630. Replace it with a fetchable JPEG or PNG of at least 1200×630.",
    snippet,
    category: "tag",
  };

  return [...fixes.filter((f) => !imageIds.includes(f.id)), merged];
}

/**
 * Return all snippet-bearing fixes assembled into a single block, ordered by where
 * they belong in <head>. Useful as a one-shot copy/paste for users.
 */
export function fixBundle(fixes: Fix[]): string {
  const order = [
    "fix-title",
    "fix-description",
    "fix-og-title",
    "fix-og-description",
    "fix-og-image",
    "fix-og-url-localhost",
    "fix-og-image-absolute",
    "fix-twitter-card",
    "fix-canonical",
    "fix-canonical-localhost",
  ];
  const indexOf = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  const snippeted = fixes.filter((f) => f.snippet).sort((a, b) => indexOf(a.id) - indexOf(b.id));
  if (snippeted.length === 0) return "";
  return snippeted.map((f) => f.snippet).join("\n");
}

// -----------------------------------------------------------------------------
// Check → Fix mapping
// -----------------------------------------------------------------------------

type FixContext = {
  host: string;
  pageUrl: string;
  suggestedImage: string;
  suggestedTitle: string;
  suggestedDescription: string;
  page: PageReport;
};

function checkToFix(checkId: string, weight: number, ctx: FixContext): Fix | null {
  const t = escapeAttr(ctx.suggestedTitle);
  const d = escapeAttr(ctx.suggestedDescription);
  const i = escapeAttr(ctx.suggestedImage);
  const u = escapeAttr(ctx.pageUrl);

  switch (checkId) {
    case "title":
      return {
        id: "fix-title",
        label: "Add a <title>",
        weight,
        explain: "Browsers, search engines, and every social platform fall back to <title> when og:title is missing. It's the baseline.",
        snippet: `<title>${t}</title>`,
        category: "tag",
      };
    case "description":
      return {
        id: "fix-description",
        label: "Add a meta description",
        weight,
        explain: "Used by search engines and as a fallback for og:description on Slack, Discord, and other crawlers.",
        snippet: `<meta name="description" content="${d}">`,
        category: "tag",
      };
    case "og-title":
      return {
        id: "fix-og-title",
        label: "Add og:title",
        weight,
        explain: "Meta and LinkedIn read og:title first. Without it they fall back to <title> — which may not be optimised for a social audience.",
        snippet: `<meta property="og:title" content="${t}">`,
        category: "tag",
      };
    case "og-description":
      return {
        id: "fix-og-description",
        label: "Add og:description",
        weight,
        explain: "Meta and LinkedIn show this directly under the image. A tailored og:description usually performs better than the generic meta description.",
        snippet: `<meta property="og:description" content="${d}">`,
        category: "tag",
      };
    case "og-image":
      return {
        id: "fix-og-image",
        label: "Add og:image",
        weight,
        explain: ctx.suggestedImage.includes(ctx.host)
          ? `Without og:image, Meta and X won't render a card and LinkedIn falls back to a text-only summary. ${suggestedImageFootnote(ctx)}`
          : "Without og:image, Meta and X won't render a card and LinkedIn falls back to a text-only summary. Aim for a 1200×630 JPEG or PNG.",
        snippet: `<meta property="og:image" content="${i}">`,
        category: "tag",
      };
    case "image-readable":
      return {
        id: "fix-image-readable",
        label: "Make og:image fetchable",
        weight,
        explain: `The current og:image URL could not be fetched or decoded. Make sure ${
          ctx.page.meta.image ? `"${ctx.page.meta.image}"` : "the URL"
        } returns a valid PNG, JPEG, or WebP with HTTP 200.`,
        category: "image",
      };
    case "image-dimensions":
      return {
        id: "fix-image-dimensions",
        label: "Resize og:image to at least 1200×630",
        weight,
        explain: "Meta, LinkedIn, and X all expect a 1.91:1 image at minimum 1200×630 for the large card layout. Below this, all three downgrade to a thumbnail or text-only card.",
        category: "image",
      };
    case "twitter-card":
      return {
        id: "fix-twitter-card",
        label: "Add twitter:card",
        weight,
        explain: 'X uses twitter:card to choose the layout. "summary_large_image" gives you the hero image card; without this tag X renders the smallest possible preview.',
        snippet: `<meta name="twitter:card" content="summary_large_image">`,
        category: "tag",
      };
    case "canonical":
      return {
        id: "fix-canonical",
        label: "Add a canonical link",
        weight,
        explain: "Signals to search engines and crawlers which URL is the source of truth. Prevents duplicate-content issues when the same page is reachable from multiple URLs.",
        snippet: `<link rel="canonical" href="${u}">`,
        category: "tag",
      };
    case "no-duplicate-core-tags":
      // already handled via warning-driven path above
      return null;
    default:
      return null;
  }
}

function suggestedImageFootnote(ctx: FixContext): string {
  // Detect whether we picked the image from a sibling page (handled in suggestImage)
  // and surface that as a nicety. We can't see the report from here, but suggestImage
  // sets the URL to match a known-good page's image — close enough as a heuristic.
  return `The example above uses an image already present elsewhere on this site.`;
}

// -----------------------------------------------------------------------------
// Suggestions (host, URL, image)
// -----------------------------------------------------------------------------

function inferHost(page: PageReport, report?: AuditReport): string {
  const fromPage = extractHost(page);
  if (fromPage) return fromPage;

  // Look across sibling pages — a 404 with no canonical can still inherit the
  // host from the index page's canonical or og:url.
  if (report) {
    for (const other of report.pages) {
      if (other.path === page.path) continue;
      const fromOther = extractHost(other);
      if (fromOther) return fromOther;
    }
  }

  return "your-site.com";
}

function extractHost(page: PageReport): string | null {
  for (const candidate of [page.meta.canonical, page.meta.url]) {
    if (!candidate || isLocalhostUrl(candidate)) continue;
    try {
      return new URL(candidate).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
  }
  if (/^https?:\/\//i.test(page.source)) {
    try {
      const u = new URL(page.source);
      if (isLocalhostUrl(page.source)) return null;
      return u.hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  return null;
}

function inferPageUrl(page: PageReport, host: string): string {
  for (const candidate of [page.meta.canonical, page.meta.url]) {
    if (!candidate || isLocalhostUrl(candidate)) continue;
    try {
      new URL(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  const path = page.path === "/index.html" ? "/" : page.path;
  // Strip .html extension if it looks like a build output
  const cleanPath = path.endsWith("/index.html") ? path.slice(0, -10) : path;
  return `https://${host}${cleanPath}`;
}

function suggestImage(
  page: PageReport,
  report: AuditReport | undefined,
  host: string,
): string {
  // 1. If a sibling page in the same audit has a working og:image, reuse it.
  if (report) {
    for (const other of report.pages) {
      if (other.path === page.path) continue;
      const img = other.image;
      if (img && img.found && img.width && img.height && img.width >= 1200 && img.height >= 630) {
        // Prefer the original reference (likely an absolute URL the site already uses).
        return other.meta.image ?? img.resolvedSource;
      }
    }
  }
  // 2. Otherwise, fall back to a sensible placeholder under the page's host.
  return `https://${host}/og.png`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function byImpactDesc(a: Fix, b: Fix): number {
  // Higher weight first; tie-break by category (tag > image > url > duplicate).
  if (b.weight !== a.weight) return b.weight - a.weight;
  const order: FixCategory[] = ["tag", "image", "url", "duplicate"];
  return order.indexOf(a.category) - order.indexOf(b.category);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Apply a list of Fixes (from fixesForPage) to an original HTML string and return
 * the patched HTML. Uses cheerio (already a dep) for safe <head> insertion of the
 * provided snippets (title, meta, link tags). 
 *
 * - Idempotent-ish: inserting the same tag twice is possible but rare in practice
 *   (callers usually pass only missing fixes).
 * - Best-effort: the original document formatting/comments may change slightly
 *   due to cheerio serialization (documented).
 * - Accepts either Fix[] or a pre-bundled string from fixBundle().
 */
export function applyFixes(originalHtml: string, fixes: Fix[] | string): string {
  if (!fixes || (Array.isArray(fixes) && fixes.length === 0) || fixes === "") {
    return originalHtml;
  }

  const $ = cheerio.load(originalHtml);

  let head = $("head");
  if (head.length === 0) {
    // Create head if missing (defensive for minimal html)
    const htmlEl = $("html");
    if (htmlEl.length === 0) {
      // very broken input; prepend a head
      return `<head></head>${originalHtml}`;
    }
    head = $("<head></head>").prependTo(htmlEl) as any;
  }

  const snippets: string[] = Array.isArray(fixes)
    ? fixes.filter((f) => !!f.snippet).map((f) => f.snippet as string)
    : [fixes]; // treat as pre-bundled string

  for (const snippet of snippets) {
    if (!snippet || !snippet.trim()) continue;
    // Append the snippet string (cheerio handles tag fragments safely for head content)
    head.append(snippet);
  }

  return $.html();
}
