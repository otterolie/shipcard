import { Parser } from "htmlparser2";
import type { AuditReport, PageReport } from "./types.js";
import { escapeHtml, isHttpUrl, isLocalhostUrl } from "./utils.js";

export type FixCategory = "tag" | "image" | "url" | "duplicate";

export type Fix = {
  id: string;
  label: string;
  /** Score points recovered (0 = quality improvement without direct score weight). */
  weight: number;
  explain: string;
  snippet?: string;
  category: FixCategory;
};

/** Generate prioritized fixes for a page. Pass the full report to inherit host and working images from sibling pages. */
export function fixesForPage(page: PageReport, report?: AuditReport): Fix[] {
  const host = inferHost(page, report);
  const pageUrl = inferPageUrl(page, host);
  const suggestedImage = suggestImage(page, report, host);
  const suggestedTitle = page.meta.title ?? page.meta.raw.titleTag ?? "Your page title";
  const suggestedDescription =
    page.meta.description ?? "A concise 50-200 character summary of this page.";

  const fixes: Fix[] = [];
  const checkIds = new Set<string>();
  let productionUrlsWeight = 0;

  for (const check of page.checks) {
    if (check.passed || check.status === "skipped") continue;
    checkIds.add(check.id);
    const missingPoints = Math.max(0, check.weight - check.earned);
    if (check.id === "production-urls") {
      productionUrlsWeight = missingPoints;
      continue;
    }
    const fix = checkToFix(check.id, missingPoints, {
      host,
      pageUrl,
      suggestedImage,
      suggestedTitle,
      suggestedDescription,
      page,
    });
    if (fix) fixes.push(fix);
  }

  const hasWarning = (...codes: string[]) => page.warnings.some((w) => codes.includes(w.code));

  const urlFixes: Fix[] = [];

  if (hasWarning("og-url-localhost", "og-url-relative")) {
    urlFixes.push({
      id: "fix-og-url-localhost",
      label: "Point og:url at production",
      weight: 0,
      explain: "og:url must be an absolute https:// URL. Localhost or relative values break crawlers.",
      snippet: `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
      category: "url",
    });
  }

  if (hasWarning("canonical-localhost", "canonical-relative")) {
    urlFixes.push({
      id: "fix-canonical-localhost",
      label: "Point canonical at production",
      weight: 0,
      explain: "canonical must be an absolute https:// URL. Localhost or relative values confuse crawlers.",
      snippet: `<link rel="canonical" href="${escapeHtml(pageUrl)}">`,
      category: "url",
    });
  }

  if (hasWarning("og-image-alt-missing")) {
    fixes.push({
      id: "fix-og-image-alt",
      label: "Add og:image:alt",
      weight: 0,
      explain: "Adding og:image:alt improves accessibility and screen-reader support on social feeds.",
      snippet: `<meta property="og:image:alt" content="${escapeHtml(suggestedTitle)}">`,
      category: "image",
    });
  }

  if (hasWarning("duplicate-core-tags") && !checkIds.has("no-duplicate-core-tags")) {
    fixes.push({
      id: "fix-duplicate-tags",
      label: "Remove duplicate core tags",
      weight: 0,
      explain: "Core tags (og:title, og:description, og:image, twitter:card, canonical) should appear at most once.",
      category: "duplicate",
    });
  }

  if (hasWarning("og-image-relative")) {
    const absImage = resolveRelativeToUrl(page.meta.image, pageUrl) ?? suggestedImage.url;
    urlFixes.push({
      id: "fix-og-image-absolute",
      label: "Use an absolute URL for og:image",
      weight: 0,
      explain: "Most social crawlers require an absolute https:// URL for og:image.",
      snippet: `<meta property="og:image" content="${escapeHtml(absImage)}">`,
      category: "image",
    });
  }

  if (hasWarning("og-image-localhost")) {
    const prodImage = swapLocalhostOrigin(page.meta.image, host) ?? suggestedImage.url;
    urlFixes.push({
      id: "fix-og-image-localhost",
      label: "Point og:image at production",
      weight: 0,
      explain: "og:image points to localhost, which external social crawlers cannot reach.",
      snippet: `<meta property="og:image" content="${escapeHtml(prodImage)}">`,
      category: "image",
    });
  }

  if (hasWarning("og-image-insecure")) {
    const httpsImage =
      page.meta.image && /^http:\/\//i.test(page.meta.image)
        ? page.meta.image.replace(/^http:\/\//i, "https://")
        : suggestedImage.url.replace(/^http:\/\//i, "https://");
    urlFixes.push({
      id: "fix-og-image-https",
      label: "Serve og:image over https",
      weight: 0,
      explain: "Some platforms block plain http:// preview images on secure pages.",
      snippet: `<meta property="og:image" content="${escapeHtml(httpsImage)}">`,
      category: "image",
    });
  }

  if (productionUrlsWeight > 0) {
    if (urlFixes.length > 0) {
      urlFixes[0].weight = productionUrlsWeight;
    } else {
      urlFixes.push({
        id: "fix-production-urls",
        label: "Use absolute https:// URLs",
        weight: productionUrlsWeight,
        explain: "Ensure og:url, canonical, and social image tags use absolute https:// URLs (not localhost, relative paths, or data URIs).",
        category: "url",
      });
    }
  }
  fixes.push(...urlFixes);

  if (hasWarning("og-image-svg")) {
    fixes.push({
      id: "fix-og-image-svg",
      label: "Export og:image as PNG, JPEG, or WebP",
      weight: 0,
      explain: "Social platforms do not render SVG link previews. Export a 1200x630 PNG, JPEG, or WebP.",
      category: "image",
    });
  }

  if (hasWarning("og-image-avif") && !checkIds.has("image-readable")) {
    fixes.push({
      id: "fix-og-image-avif",
      label: "Use PNG, JPEG, or WebP instead of AVIF",
      weight: 0,
      explain: "Several social platforms (including X and LinkedIn) do not reliably display AVIF link previews.",
      category: "image",
    });
  }

  if (hasWarning("og-image-aspect-ratio") && !checkIds.has("image-aspect-ratio")) {
    fixes.push({
      id: "fix-og-image-aspect-ratio",
      label: "Crop og:image closer to 1.91:1 (1200x630)",
      weight: 0,
      explain: "Square, portrait, or ultra-wide images get cropped awkwardly on X, Meta, and LinkedIn cards.",
      category: "image",
    });
  }

  if (hasWarning("meta-too-late")) {
    fixes.push({
      id: "fix-meta-too-late",
      label: "Move social meta tags near the top of <head>",
      weight: 0,
      explain: "Crawlers like Slack, WhatsApp, and Discord truncate large HTML responses; place og:* and twitter:* tags before inline styles or scripts.",
      category: "tag",
    });
  }

  if (hasWarning("og-image-too-large")) {
    fixes.push({
      id: "fix-og-image-too-large",
      label: "Compress og:image below 5 MB",
      weight: 0,
      explain: "Images over 5 MB are rejected by several platforms. Re-export as a compressed JPEG or PNG (under 600 KB for WhatsApp).",
      category: "image",
    });
  }

  return mergeImageFixes(fixes, suggestedImage.fromSibling).sort(byImpactDesc);
}

function mergeImageFixes(fixes: Fix[], fromSibling: boolean): Fix[] {
  const imageIds = new Set([
    "fix-og-image",
    "fix-image-readable",
    "fix-image-dimensions",
    "fix-og-image-aspect-ratio",
  ]);
  const imageFixes = fixes.filter((f) => imageIds.has(f.id));
  if (imageFixes.length <= 1) return fixes;

  const totalWeight = imageFixes.reduce((sum, f) => sum + f.weight, 0);
  const missingTag = imageFixes.find((f) => f.id === "fix-og-image");
  const siblingNote = fromSibling
    ? " The snippet reuses a working image from another page on this site."
    : "";

  const merged: Fix = {
    id: "fix-og-image-combined",
    label: missingTag
      ? "Add a 1200x630 og:image"
      : "Replace og:image with a valid 1200x630 image",
    weight: totalWeight,
    explain: missingTag
      ? `Without og:image, social cards render without an image or not at all. Use a PNG, JPEG, or WebP at least 1200x630 (1.91:1) at an absolute https:// URL.${siblingNote}`
      : "The current og:image could not be loaded as a PNG/JPEG/WebP, is smaller than 1200x630, or has an off aspect ratio.",
    snippet: missingTag?.snippet,
    category: missingTag ? "tag" : "image",
  };

  return [...fixes.filter((f) => !imageIds.has(f.id)), merged];
}

/** Combine all snippet-bearing fixes in natural <head> order. */
export function fixBundle(fixes: Fix[]): string {
  const order = [
    "fix-title",
    "fix-description",
    "fix-og-title",
    "fix-og-description",
    "fix-og-image-combined",
    "fix-og-image",
    "fix-og-image-absolute",
    "fix-og-image-localhost",
    "fix-og-image-https",
    "fix-og-image-alt",
    "fix-og-url-localhost",
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

type FixContext = {
  host: string;
  pageUrl: string;
  suggestedImage: { url: string; fromSibling: boolean };
  suggestedTitle: string;
  suggestedDescription: string;
  page: PageReport;
};

function checkToFix(checkId: string, weight: number, ctx: FixContext): Fix | null {
  const t = escapeHtml(ctx.suggestedTitle);
  const d = escapeHtml(ctx.suggestedDescription);
  const i = escapeHtml(ctx.suggestedImage.url);
  const u = escapeHtml(ctx.pageUrl);

  switch (checkId) {
    case "title":
      return {
        id: "fix-title",
        label: "Add a <title>",
        weight,
        explain: "Browsers, search engines, and social crawlers fall back to <title> when og:title is absent.",
        snippet: `<title>${t}</title>`,
        category: "tag",
      };
    case "description":
      return {
        id: "fix-description",
        label: "Add a meta description",
        weight,
        explain: "Used by search engines and as a fallback when og:description is missing.",
        snippet: `<meta name="description" content="${d}">`,
        category: "tag",
      };
    case "og-title":
      return {
        id: "fix-og-title",
        label: "Add og:title",
        weight,
        explain: "Primary title used by Meta, LinkedIn, Slack, and most social link previews.",
        snippet: `<meta property="og:title" content="${t}">`,
        category: "tag",
      };
    case "og-description":
      return {
        id: "fix-og-description",
        label: "Add og:description",
        weight,
        explain: "Shown directly below the title on social cards.",
        snippet: `<meta property="og:description" content="${d}">`,
        category: "tag",
      };
    case "og-image":
      return {
        id: "fix-og-image",
        label: "Add og:image",
        weight,
        explain: ctx.suggestedImage.fromSibling
          ? "Primary preview image for social cards. The snippet reuses a working image from another page on this site."
          : "Primary preview image for social cards. Use a 1200x630 PNG, JPEG, or WebP.",
        snippet: `<meta property="og:image" content="${i}">`,
        category: "tag",
      };
    case "image-readable":
      return {
        id: "fix-image-readable",
        label: "Make og:image loadable",
        weight,
        explain: `Make sure ${
          ctx.page.meta.image ? `"${ctx.page.meta.image}"` : "the image URL"
        } returns a valid PNG, JPEG, or WebP with HTTP 200.`,
        category: "image",
      };
    case "image-dimensions":
      return {
        id: "fix-image-dimensions",
        label: "Resize og:image to at least 1200x630",
        weight,
        explain: "Meta, LinkedIn, and X expect at least 1200x630 (1.91:1) for large card layouts.",
        category: "image",
      };
    case "image-aspect-ratio":
      return {
        id: "fix-og-image-aspect-ratio",
        label: "Crop og:image closer to 1.91:1 (1200x630)",
        weight,
        explain: "Square, portrait, or ultra-wide images get cropped awkwardly on X, Meta, and LinkedIn cards.",
        category: "image",
      };
    case "twitter-card":
      return {
        id: "fix-twitter-card",
        label: ctx.page.meta.twitterCard ? "Fix invalid twitter:card" : "Add twitter:card",
        weight,
        explain: 'Controls card layout on X and Discord. Use "summary_large_image" for a full-width image card.',
        snippet: `<meta name="twitter:card" content="summary_large_image">`,
        category: "tag",
      };
    case "canonical":
      return {
        id: "fix-canonical",
        label: "Add a canonical link",
        weight,
        explain: "Tells crawlers the canonical URL for this page.",
        snippet: `<link rel="canonical" href="${u}">`,
        category: "tag",
      };
    case "no-duplicate-core-tags":
      return {
        id: "fix-duplicate-tags",
        label: "Remove duplicate core tags",
        weight,
        explain: "Keep at most one copy of og:title, og:description, og:image, twitter:card, and canonical.",
        category: "duplicate",
      };
    default:
      return null;
  }
}

function inferHost(page: PageReport, report?: AuditReport): string {
  const fromPage = extractHost(page);
  if (fromPage) return fromPage;

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
  for (const candidate of [page.meta.canonical, page.meta.url, page.source]) {
    if (!candidate || !isHttpUrl(candidate) || isLocalhostUrl(candidate)) continue;
    try {
      return new URL(candidate).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
  }
  return null;
}

function inferPageUrl(page: PageReport, host: string): string {
  for (const candidate of [page.meta.canonical, page.meta.url]) {
    if (!candidate || !isHttpUrl(candidate) || isLocalhostUrl(candidate)) continue;
    return candidate;
  }

  if (isHttpUrl(page.path)) {
    if (!isLocalhostUrl(page.path)) return page.path;
    try {
      const u = new URL(page.path);
      return `https://${host}${u.pathname}${u.search}`;
    } catch {
      // fall through
    }
  }

  const p = page.path === "/index.html" || page.path === "/stdin.html" ? "/" : page.path;
  const cleanPath = p.endsWith("/index.html") ? p.slice(0, -10) : p;
  return `https://${host}${cleanPath.startsWith("/") ? cleanPath : "/" + cleanPath}`;
}

function suggestImage(
  page: PageReport,
  report: AuditReport | undefined,
  host: string,
): { url: string; fromSibling: boolean } {
  if (report) {
    for (const other of report.pages) {
      if (other.path === page.path) continue;
      const img = other.image;
      if (img && img.found && img.width && img.height && img.width >= 1200 && img.height >= 630) {
        return { url: other.meta.image ?? img.resolvedSource, fromSibling: true };
      }
    }
  }
  return { url: `https://${host}/og.png`, fromSibling: false };
}

function resolveRelativeToUrl(ref: string | null, pageUrl: string): string | null {
  if (!ref) return null;
  try {
    return new URL(ref, pageUrl).toString();
  } catch {
    return null;
  }
}

function swapLocalhostOrigin(ref: string | null, host: string): string | null {
  if (!ref || !isHttpUrl(ref)) return null;
  try {
    const u = new URL(ref);
    return `https://${host}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

function byImpactDesc(a: Fix, b: Fix): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  const order: FixCategory[] = ["tag", "image", "url", "duplicate"];
  return order.indexOf(a.category) - order.indexOf(b.category);
}

type Span = [number, number];
type Edit = { start: number; end: number; replacement: string };
type SnippetTarget =
  | { kind: "title" }
  | { kind: "meta"; key: string }
  | { kind: "link"; rel: string }
  | { kind: "raw" };

/**
 * Splice Fix snippets (or a fixBundle string) directly into <head> using
 * parser character offsets, preserving existing document formatting and
 * replacing matching tags in place instead of creating duplicates.
 */
export function applyFixes(originalHtml: string, fixes: Fix[] | string): string {
  if (!fixes || (Array.isArray(fixes) && fixes.length === 0) || fixes === "") {
    return originalHtml;
  }

  const rawSnippets = Array.isArray(fixes)
    ? fixes.map((f) => f.snippet).filter((s): s is string => !!s?.trim())
    : fixes.split(/\r?\n/).filter((s) => s.trim().length > 0);

  // Deduplicate incoming snippets that target the same tag so edits never overlap.
  const snippets: Array<{ snippet: string; target: SnippetTarget }> = [];
  const seenTargets = new Set<string>();
  for (const raw of rawSnippets) {
    const snippet = raw.trim();
    if (!snippet || snippet.startsWith("<!--")) continue;
    const target = parseSnippetTarget(snippet);
    const id = targetId(target);
    if (id) {
      if (seenTargets.has(id)) continue;
      seenTargets.add(id);
    }
    snippets.push({ snippet, target });
  }

  if (snippets.length === 0) return originalHtml;

  const index = indexDocument(originalHtml);
  const edits: Edit[] = [];
  const toAppend: string[] = [];

  for (const { snippet, target } of snippets) {
    const spans = lookupSpans(index, target);
    if (spans.length > 0) {
      const [first, ...rest] = spans;
      edits.push({ start: first[0], end: first[1], replacement: snippet });
      for (const extra of rest) {
        const [rmStart, rmEnd] = expandLineRemoval(originalHtml, extra[0], extra[1]);
        edits.push({ start: rmStart, end: rmEnd, replacement: "" });
      }
    } else {
      toAppend.push(snippet);
    }
  }

  if (toAppend.length > 0) {
    const indent = detectHeadIndent(originalHtml, index.headClosePos);
    const block = toAppend.map((s) => `${indent}${s}`).join("\n");

    if (index.headClosePos !== null) {
      const before = originalHtml.slice(0, index.headClosePos);
      const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
      const lineStart = before.lastIndexOf("\n") + 1;
      const headCloseIndent = before.slice(lineStart);
      const hasOnlySpacesBeforeClose = /^[ \t]*$/.test(headCloseIndent);

      if (hasOnlySpacesBeforeClose && before.includes("\n")) {
        edits.push({
          start: lineStart,
          end: lineStart,
          replacement: `${block}\n`,
        });
      } else {
        edits.push({
          start: index.headClosePos,
          end: index.headClosePos,
          replacement: `${needsLeadingNewline ? "\n" : ""}${block}\n`,
        });
      }
    } else if (index.htmlOpenEnd !== null) {
      edits.push({
        start: index.htmlOpenEnd,
        end: index.htmlOpenEnd,
        replacement: `\n<head>\n${block}\n</head>`,
      });
    } else {
      edits.push({
        start: 0,
        end: 0,
        replacement: `<head>\n${block}\n</head>\n`,
      });
    }
  }

  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = originalHtml;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

function parseSnippetTarget(snippet: string): SnippetTarget {
  let result: SnippetTarget = { kind: "raw" };
  let captured = false;

  const parser = new Parser({
    onopentag(name, attribs) {
      if (captured) return;
      captured = true;
      if (name === "title") {
        result = { kind: "title" };
      } else if (name === "meta") {
        const key = (attribs.property || attribs.name || "").trim().toLowerCase();
        if (key) result = { kind: "meta", key };
      } else if (name === "link") {
        const rel = (attribs.rel || "").trim().toLowerCase().split(/\s+/)[0];
        if (rel) result = { kind: "link", rel };
      }
    },
  });

  parser.write(snippet);
  parser.end();
  return result;
}

function targetId(target: SnippetTarget): string | null {
  if (target.kind === "title") return "title";
  if (target.kind === "meta") return `meta:${target.key}`;
  if (target.kind === "link") return `link:${target.rel}`;
  return null;
}

type DocIndex = {
  titleSpans: Span[];
  metaSpans: Map<string, Span[]>;
  linkSpans: Map<string, Span[]>;
  headClosePos: number | null;
  htmlOpenEnd: number | null;
};

function indexDocument(html: string): DocIndex {
  const titleSpans: Span[] = [];
  const metaSpans = new Map<string, Span[]>();
  const linkSpans = new Map<string, Span[]>();
  let headClosePos: number | null = null;
  let htmlOpenEnd: number | null = null;

  let svgDepth = 0;
  let openTitleStart: number | null = null;

  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "svg") {
        svgDepth++;
        return;
      }
      if (name === "html" && htmlOpenEnd === null) {
        htmlOpenEnd = parser.endIndex + 1;
        return;
      }
      if (name === "title" && svgDepth === 0) {
        openTitleStart = parser.startIndex;
        return;
      }
      if (name === "meta") {
        const key = (attribs.property || attribs.name || "").trim().toLowerCase();
        if (!key) return;
        const span: Span = [parser.startIndex, parser.endIndex + 1];
        (metaSpans.get(key) ?? metaSpans.set(key, []).get(key)!).push(span);
        return;
      }
      if (name === "link") {
        const relAttr = (attribs.rel || "").trim().toLowerCase();
        if (!relAttr) return;
        const span: Span = [parser.startIndex, parser.endIndex + 1];
        for (const rel of relAttr.split(/\s+/)) {
          if (rel) (linkSpans.get(rel) ?? linkSpans.set(rel, []).get(rel)!).push(span);
        }
      }
    },
    onclosetag(name, isImplied) {
      if (name === "svg" && svgDepth > 0) {
        svgDepth--;
        return;
      }
      if (name === "title" && openTitleStart !== null) {
        titleSpans.push([openTitleStart, parser.endIndex + 1]);
        openTitleStart = null;
        return;
      }
      if (name === "head" && !isImplied && headClosePos === null) {
        headClosePos = parser.startIndex;
      }
    },
  });

  parser.write(html);
  parser.end();

  return { titleSpans, metaSpans, linkSpans, headClosePos, htmlOpenEnd };
}

function lookupSpans(index: DocIndex, target: SnippetTarget): Span[] {
  if (target.kind === "title") return index.titleSpans;
  if (target.kind === "meta") return index.metaSpans.get(target.key) ?? [];
  if (target.kind === "link") return index.linkSpans.get(target.rel) ?? [];
  return [];
}

function expandLineRemoval(html: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s > 0 && (html[s - 1] === " " || html[s - 1] === "\t")) s--;
  if (s === 0 || html[s - 1] === "\n") {
    if (html[e] === "\r" && html[e + 1] === "\n") e += 2;
    else if (html[e] === "\n") e += 1;
  } else {
    s = start;
  }
  return [s, e];
}

function detectHeadIndent(html: string, headClosePos: number | null): string {
  if (headClosePos === null) return "  ";
  const before = html.slice(0, headClosePos);
  const match = before.match(/\n([ \t]+)<(?:meta|title|link)\b/i);
  return match ? match[1] : "  ";
}
