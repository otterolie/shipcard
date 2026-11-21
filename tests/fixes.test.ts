import { describe, it, expect } from "vitest";
import { fixesForPage, fixBundle, applyFixes } from "../src/fixes.js";
import { extractMeta } from "../src/extract-meta.js";
import { scorePage, statusFromScore } from "../src/score.js";
import { platformPreviews } from "../src/platforms.js";
import { auditHtml } from "../src/audit-html.js";
import type { AuditReport, ImageAudit, PageReport } from "../src/types.js";

function buildPage(html: string, image: ImageAudit | null = null, path = "/page.html"): PageReport {
  const meta = extractMeta(html);
  const { score, checks } = scorePage(meta, image);
  return {
    path,
    source: path,
    score,
    status: statusFromScore(score),
    meta,
    image,
    checks,
    warnings: [],
    platforms: platformPreviews(meta, image),
  };
}

function buildReport(pages: PageReport[]): AuditReport {
  return {
    tool: "shipcard",
    version: "0.2.0",
    createdAt: new Date().toISOString(),
    target: { type: "folder", input: "/tmp/site" },
    summary: { score: 0, pagesScanned: pages.length, passed: 0, warnings: 0, failed: pages.length },
    pages,
  };
}

const goodImage: ImageAudit = {
  source: "https://example.com/og.png",
  resolvedSource: "https://example.com/og.png",
  found: true,
  external: true,
  contentType: "image/png",
  width: 1200,
  height: 630,
  sizeBytes: 50_000,
  format: "png",
  warnings: [],
};

describe("fixesForPage", () => {
  it("produces zero fixes for a complete page", () => {
    const html = `<html><head>
      <title>T</title>
      <meta name="description" content="D" />
      <meta property="og:title" content="T" />
      <meta property="og:description" content="D" />
      <meta property="og:image" content="https://example.com/og.png" />
      <meta name="twitter:card" content="summary_large_image" />
      <link rel="canonical" href="https://example.com/" />
    </head></html>`;
    const page = buildPage(html, goodImage);
    expect(fixesForPage(page)).toEqual([]);
  });

  it("merges og:image + image-readable + image-dimensions into a single combined fix", () => {
    const page = buildPage(`<html><head></head></html>`);
    const fixes = fixesForPage(page);
    expect(fixes.find((f) => f.id === "fix-og-image")).toBeUndefined();
    expect(fixes.find((f) => f.id === "fix-image-readable")).toBeUndefined();
    expect(fixes.find((f) => f.id === "fix-image-dimensions")).toBeUndefined();
    const combined = fixes.find((f) => f.id === "fix-og-image-combined");
    expect(combined?.weight).toBe(45);
    expect(combined?.explain).not.toContain("another page on this site");
  });

  it("orders fixes by weight descending and weights sum to 100 - score", () => {
    const page = buildPage(`<html><head></head></html>`);
    const fixes = fixesForPage(page);
    for (let i = 1; i < fixes.length; i++) {
      expect(fixes[i - 1].weight).toBeGreaterThanOrEqual(fixes[i].weight);
    }
    const totalWeight = fixes.reduce((sum, f) => sum + f.weight, 0);
    expect(totalWeight).toBe(100 - page.score);
  });

  it("gives duplicate-core-tags fix its full weight of 5", () => {
    const html = `<html><head>
      <title>T</title>
      <meta name="description" content="D" />
      <meta property="og:title" content="A" />
      <meta property="og:title" content="B" />
      <meta property="og:description" content="D" />
      <meta property="og:image" content="https://example.com/og.png" />
      <meta name="twitter:card" content="summary_large_image" />
      <link rel="canonical" href="https://example.com/" />
    </head></html>`;
    const page = buildPage(html, goodImage);
    const fixes = fixesForPage(page);
    const dupeFix = fixes.find((f) => f.id === "fix-duplicate-tags");
    expect(dupeFix?.weight).toBe(5);
    expect(fixes.reduce((s, f) => s + f.weight, 0)).toBe(100 - page.score);
  });

  it("reuses an og:image URL from a sibling page and only then notes sibling reuse", () => {
    const goodPage = buildPage(
      `<html><head>
        <meta property="og:title" content="T" />
        <meta property="og:image" content="https://example.com/hero.jpg" />
      </head></html>`,
      goodImage,
      "/index.html",
    );
    const badPage = buildPage(`<html><head><title>T</title></head></html>`, null, "/404.html");
    const report = buildReport([goodPage, badPage]);

    const imageFix = fixesForPage(badPage, report).find((f) => f.id === "fix-og-image-combined");
    expect(imageFix?.snippet).toContain("https://example.com/hero.jpg");
    expect(imageFix?.explain).toContain("another page on this site");
  });

  it("falls back to a placeholder URL under the page's host when no sibling has one", () => {
    const page = buildPage(
      `<html><head><link rel="canonical" href="https://acme.test/page" /></head></html>`,
    );
    const fix = fixesForPage(page).find((f) => f.id === "fix-og-image-combined");
    expect(fix?.snippet).toContain("https://acme.test/og.png");
  });

  it("does not corrupt canonical URLs when page.path is already a full HTTP URL", () => {
    const page = buildPage(`<html><head><title>T</title></head></html>`, null, "https://acme.test/pricing");
    const fix = fixesForPage(page).find((f) => f.id === "fix-canonical");
    expect(fix?.snippet).toBe('<link rel="canonical" href="https://acme.test/pricing">');
  });

  it("preserves the actual image path for relative and http:// og:image fixes", async () => {
    const relPage = await auditHtml(
      `<html><head>
        <title>T</title>
        <meta property="og:image" content="/assets/card.png" />
        <link rel="canonical" href="https://acme.test/blog/post" />
      </head></html>`,
      { source: "t", path: "/blog/post.html", validateImages: true, offline: true },
    );
    const absFix = fixesForPage(relPage).find((f) => f.id === "fix-og-image-absolute");
    expect(absFix?.snippet).toContain("https://acme.test/assets/card.png");

    const httpPage = await auditHtml(
      `<html><head>
        <title>T</title>
        <meta property="og:image" content="http://acme.test/assets/card.png" />
        <link rel="canonical" href="https://acme.test/" />
      </head></html>`,
      { source: "t", path: "/index.html", validateImages: true, offline: true },
    );
    const httpsFix = fixesForPage(httpPage).find((f) => f.id === "fix-og-image-https");
    expect(httpsFix?.snippet).toContain("https://acme.test/assets/card.png");
  });

  it("inherits the host from a sibling page when the current page has none", () => {
    const goodPage = buildPage(
      `<html><head><link rel="canonical" href="https://acme.test/" /></head></html>`,
      goodImage,
      "/index.html",
    );
    const badPage = buildPage(`<html><head></head></html>`, null, "/404.html");
    const report = buildReport([goodPage, badPage]);

    const canonicalFix = fixesForPage(badPage, report).find((f) => f.id === "fix-canonical");
    expect(canonicalFix?.snippet).toContain("acme.test");
    expect(canonicalFix?.snippet).not.toContain("your-site.com");
  });

  it("HTML-escapes user content in suggested snippets", () => {
    const page = buildPage(`<html><head><title>Title with "quotes" &amp; more</title></head></html>`);
    const fix = fixesForPage(page).find((f) => f.id === "fix-og-title");
    expect(fix?.snippet).toContain("&quot;");
    expect(fix?.snippet).not.toContain('"quotes"');
  });
});

describe("fixBundle", () => {
  it("returns an empty string when no snippet-bearing fixes exist", () => {
    const html = `<html><head>
      <title>T</title><meta name="description" content="D" />
      <meta property="og:title" content="T" /><meta property="og:description" content="D" />
      <meta property="og:image" content="https://example.com/og.png" />
      <meta name="twitter:card" content="summary_large_image" />
      <link rel="canonical" href="https://example.com/" />
    </head></html>`;
    const page = buildPage(html, goodImage);
    expect(fixBundle(fixesForPage(page))).toBe("");
  });

  it("orders bundled snippets naturally (title, og:title, og:image, twitter:card, canonical)", () => {
    const page = buildPage(`<html><head></head></html>`);
    const bundle = fixBundle(fixesForPage(page));
    const titlePos = bundle.indexOf("<title>");
    const ogTitlePos = bundle.indexOf("og:title");
    const ogImagePos = bundle.indexOf("og:image");
    const twitterPos = bundle.indexOf("twitter:card");
    const canonicalPos = bundle.indexOf("canonical");
    expect(titlePos).toBeGreaterThanOrEqual(0);
    expect(titlePos).toBeLessThan(ogTitlePos);
    expect(ogTitlePos).toBeLessThan(ogImagePos);
    expect(ogImagePos).toBeLessThan(twitterPos);
    expect(twitterPos).toBeLessThan(canonicalPos);
  });
});

describe("applyFixes", () => {
  it("applies snippet fixes and improves score without live network calls", async () => {
    const original = `<html><head><title>T</title></head><body></body></html>`;
    const page = await auditHtml(original, { source: "t", path: "/", validateImages: false });
    const fixes = fixesForPage(page);
    const patched = applyFixes(original, fixes);
    expect(patched).toContain("og:title");

    const patchedPage = await auditHtml(patched, { source: "t", path: "/", validateImages: false });
    expect(patchedPage.score).toBeGreaterThan(page.score);
  });

  it("replaces existing localhost/relative tags instead of creating duplicates", async () => {
    const original = `<html><head>
      <title>T</title>
      <meta property="og:url" content="http://localhost:3000/about" />
      <meta property="og:image" content="./og.png" />
      <link rel="canonical" href="/about" />
    </head><body></body></html>`;
    const page = await auditHtml(original, {
      source: "t",
      path: "/about.html",
      validateImages: true,
      offline: true,
    });
    const fixes = fixesForPage(page);
    const patched = applyFixes(original, fixes);
    const meta = extractMeta(patched);

    expect(meta.raw.openGraph["url"]).toHaveLength(1);
    expect(meta.raw.openGraph["image"]).toHaveLength(1);
    expect(meta.raw.links["canonical"]).toHaveLength(1);
    expect(meta.url).not.toContain("localhost");
    expect(meta.image).toMatch(/^https:\/\//);
    expect(meta.canonical).toMatch(/^https:\/\//);
  });

  it("preserves existing HTML formatting, doctype, and comments when applying fixes", () => {
    const original = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <!-- keep me -->\n  <title>My Site</title>\n</head>\n<body>\n  <div data-custom='single-quotes'>Hello</div>\n</body>\n</html>\n`;
    const page = buildPage(original);
    const fixes = fixesForPage(page);
    const patched = applyFixes(original, fixes);

    expect(patched).toContain("<!DOCTYPE html>");
    expect(patched).toContain("<!-- keep me -->");
    expect(patched).toContain("<div data-custom='single-quotes'>Hello</div>");
    expect(patched).toContain('<meta property="og:title" content="My Site">');
  });

  it("is a no-op when fixes are empty", () => {
    const html = "<html><head><title>T</title></head></html>";
    expect(applyFixes(html, [])).toBe(html);
    expect(applyFixes(html, "")).toBe(html);
  });
});
