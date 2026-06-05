import { describe, it, expect } from "vitest";
import { fixesForPage, fixBundle } from "../src/fixes.js";
import { extractMeta } from "../src/extract-meta.js";
import { scorePage, statusFromScore } from "../src/score.js";
import { platformPreviews } from "../src/platforms.js";
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
    version: "0.3.0",
    createdAt: new Date().toISOString(),
    target: { type: "folder", input: "/tmp/site" },
    summary: { score: 0, pagesScanned: pages.length, ready: 0, warnings: 0, failed: pages.length },
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
  it("produces zero fixes for a perfect page", () => {
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

  it("produces a fix for every failing check on an empty page", () => {
    const page = buildPage(`<html><head></head></html>`);
    const fixes = fixesForPage(page);
    // Image-related checks (og:image, readable, dimensions) merge into one combined
    // fix because the user really only needs to provide one good image.
    expect(fixes.find((f) => f.id === "fix-og-image-combined")).toBeDefined();
    expect(fixes.find((f) => f.id === "fix-og-title")).toBeDefined();
    expect(fixes.find((f) => f.id === "fix-twitter-card")).toBeDefined();
    expect(fixes.find((f) => f.id === "fix-canonical")).toBeDefined();
  });

  it("merges og:image + image-readable + image-dimensions into a single combined fix", () => {
    const page = buildPage(`<html><head></head></html>`);
    const fixes = fixesForPage(page);
    expect(fixes.find((f) => f.id === "fix-og-image")).toBeUndefined();
    expect(fixes.find((f) => f.id === "fix-image-readable")).toBeUndefined();
    expect(fixes.find((f) => f.id === "fix-image-dimensions")).toBeUndefined();
    const combined = fixes.find((f) => f.id === "fix-og-image-combined");
    expect(combined?.weight).toBe(45); // 20 + 15 + 10
  });

  it("orders fixes by weight descending", () => {
    const page = buildPage(`<html><head></head></html>`);
    const fixes = fixesForPage(page);
    for (let i = 1; i < fixes.length; i++) {
      expect(fixes[i - 1].weight).toBeGreaterThanOrEqual(fixes[i].weight);
    }
  });

  it("includes weights that add up to the points needed to reach 100", () => {
    const page = buildPage(`<html><head></head></html>`);
    const fixes = fixesForPage(page);
    const totalWeight = fixes.reduce((sum, f) => sum + f.weight, 0);
    // The "no-duplicate-core-tags" check is the only one that passes for an empty
    // page (5 points), so missing weight = 100 - 5 = 95.
    expect(totalWeight).toBe(95);
  });

  it("reuses an og:image URL from a sibling page when one exists", () => {
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

    const fixes = fixesForPage(badPage, report);
    const imageFix = fixes.find((f) => f.id === "fix-og-image-combined");
    expect(imageFix?.snippet).toContain("https://example.com/hero.jpg");
  });

  it("falls back to a placeholder URL under the page's host when no sibling has one", () => {
    const page = buildPage(
      `<html><head>
        <link rel="canonical" href="https://acme.test/page" />
      </head></html>`,
    );
    const fix = fixesForPage(page).find((f) => f.id === "fix-og-image-combined");
    expect(fix?.snippet).toContain("https://acme.test/og.png");
  });

  it("inherits the host from a sibling page when the current page has none", () => {
    const goodPage = buildPage(
      `<html><head>
        <link rel="canonical" href="https://acme.test/" />
      </head></html>`,
      goodImage,
      "/index.html",
    );
    const badPage = buildPage(`<html><head></head></html>`, null, "/404.html");
    const report = buildReport([goodPage, badPage]);

    const canonicalFix = fixesForPage(badPage, report).find((f) => f.id === "fix-canonical");
    expect(canonicalFix?.snippet).toContain("acme.test");
    expect(canonicalFix?.snippet).not.toContain("your-site.com");
  });

  it("uses existing <title> as the og:title content when only og:title is missing", () => {
    const page = buildPage(`<html><head><title>Real Page Title</title></head></html>`);
    const fix = fixesForPage(page).find((f) => f.id === "fix-og-title");
    expect(fix?.snippet).toContain("Real Page Title");
  });

  it("uses existing meta description as og:description content", () => {
    const page = buildPage(`
      <html><head>
        <meta name="description" content="An actual description from the site." />
      </head></html>
    `);
    const fix = fixesForPage(page).find((f) => f.id === "fix-og-description");
    expect(fix?.snippet).toContain("An actual description from the site.");
  });

  it("HTML-escapes user content in suggested snippets", () => {
    const page = buildPage(`<html><head><title>Title with "quotes" &amp; more</title></head></html>`);
    const fix = fixesForPage(page).find((f) => f.id === "fix-og-title");
    expect(fix?.snippet).toContain("&quot;");
    expect(fix?.snippet).not.toContain('"quotes"');
  });
});

describe("fixBundle", () => {
  it("returns an empty string when no snippet-bearing fixes", () => {
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

  it("orders bundled snippets in <head>-natural order (title, meta, og:*, twitter, link)", () => {
    const page = buildPage(`<html><head></head></html>`);
    const bundle = fixBundle(fixesForPage(page));
    const titlePos = bundle.indexOf("<title>");
    const ogTitlePos = bundle.indexOf("og:title");
    const twitterPos = bundle.indexOf("twitter:card");
    const canonicalPos = bundle.indexOf("canonical");
    expect(titlePos).toBeGreaterThanOrEqual(0);
    expect(titlePos).toBeLessThan(ogTitlePos);
    expect(ogTitlePos).toBeLessThan(twitterPos);
    expect(twitterPos).toBeLessThan(canonicalPos);
  });
});

describe("applyFixes", () => {
  it("applies snippet fixes to html and roundtrips usefully (score can only improve or stay)", async () => {
    const { applyFixes, fixesForPage, auditHtml, scorePage } = await import("../src/index.js");
    const original = `<html><head><title>T</title></head><body></body></html>`;
    const page = await auditHtml(original, { source: "t", path: "/" });
    const fixes = fixesForPage(page);
    const patched = applyFixes(original, fixes);
    expect(patched).toContain("og:title"); // at least some tags added
    // re-audit patched should not be worse
    const patchedPage = await auditHtml(patched, { source: "t", path: "/" });
    expect(patchedPage.score).toBeGreaterThanOrEqual(page.score);
  });

  it("is a no-op when no fixes or empty", async () => {
    const html = "<html><head><title>T</title></head></html>";
    const { applyFixes } = await import("../src/fixes.js");
    expect(applyFixes(html, [])).toBe(html);
    expect(applyFixes(html, "")).toBe(html);
  });
});
