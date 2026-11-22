import { describe, it, expect } from "vitest";
import {
  scorePage,
  statusFromScore,
  pageStatus,
  isValidTwitterCard,
  hasDuplicateCoreTags,
} from "../src/score.js";
import { extractMeta } from "../src/extract-meta.js";
import type { ImageAudit, SocialMeta } from "../src/types.js";

function emptyMeta(): SocialMeta {
  return extractMeta("<html><head></head></html>");
}

function fullMeta(): SocialMeta {
  return extractMeta(`
    <html><head>
      <title>T</title>
      <meta name="description" content="D" />
      <meta property="og:title" content="OT" />
      <meta property="og:description" content="OD" />
      <meta property="og:image" content="https://example.com/og.png" />
      <meta name="twitter:card" content="summary_large_image" />
      <link rel="canonical" href="https://example.com/" />
    </head></html>
  `);
}

function goodImage(): ImageAudit {
  return {
    source: "https://example.com/og.png",
    resolvedSource: "https://example.com/og.png",
    found: true,
    external: true,
    contentType: "image/png",
    width: 1200,
    height: 630,
    sizeBytes: 80_000,
    format: "png",
    warnings: [],
  };
}

describe("scorePage", () => {
  it("gives a perfect 100 with full metadata and a good 1200x630 image", () => {
    const { score, checks } = scorePage(fullMeta(), goodImage());
    expect(score).toBe(100);
    expect(checks.every((c) => c.passed && c.status === "pass")).toBe(true);
  });

  it("only credits no-duplicate-core-tags for empty metadata", () => {
    const { score, checks } = scorePage(emptyMeta(), null);
    expect(score).toBe(5);
    const passed = checks.filter((c) => c.passed).map((c) => c.id);
    expect(passed).toEqual(["no-duplicate-core-tags"]);
  });

  it("excludes skipped image checks from the denominator when imagesSkipped is true", () => {
    const { score, checks } = scorePage(fullMeta(), null, { imagesSkipped: true });
    expect(score).toBe(100);
    const skipped = checks.filter((c) => c.status === "skipped").map((c) => c.id);
    expect(skipped).toEqual(["image-readable", "image-dimensions", "image-aspect-ratio"]);
  });

  it("excludes skipped image checks when image was skipped due to --offline", () => {
    const offlineImage: ImageAudit = {
      ...goodImage(),
      found: false,
      width: null,
      height: null,
      warnings: [{ severity: "warning", code: "og-image-offline", message: "Skipped (--offline)." }],
    };
    const { score, checks } = scorePage(fullMeta(), offlineImage);
    expect(score).toBe(100);
    expect(checks.find((c) => c.id === "image-readable")?.status).toBe("skipped");
  });

  it("gives partial credit for <title> and meta description fallbacks", () => {
    const meta = extractMeta(`
      <html><head>
        <title>Plain Title</title>
        <meta name="description" content="Plain desc" />
      </head></html>
    `);
    const { checks } = scorePage(meta, null);
    const titleCheck = checks.find((c) => c.id === "og-title");
    const descCheck = checks.find((c) => c.id === "og-description");
    expect(titleCheck?.status).toBe("partial");
    expect(titleCheck?.earned).toBe(8);
    expect(descCheck?.status).toBe("partial");
    expect(descCheck?.earned).toBe(5);
  });

  it("deducts 10 for an undersized image with valid aspect ratio", () => {
    const img: ImageAudit = { ...goodImage(), width: 800, height: 420 };
    const { score } = scorePage(fullMeta(), img);
    expect(score).toBe(90);
  });

  it("deducts 5 for an off-aspect-ratio image (e.g. 1200x1200 square)", () => {
    const img: ImageAudit = { ...goodImage(), width: 1200, height: 1200 };
    const { score, checks } = scorePage(fullMeta(), img);
    expect(score).toBe(95);
    expect(checks.find((c) => c.id === "image-aspect-ratio")?.passed).toBe(false);
  });

  it("gives partial credit for AVIF images", () => {
    const img: ImageAudit = { ...goodImage(), format: "avif", contentType: "image/avif" };
    const { score, checks } = scorePage(fullMeta(), img);
    expect(score).toBe(93);
    expect(checks.find((c) => c.id === "image-readable")?.status).toBe("partial");
  });

  it("deducts 30 when image is unreadable or SVG", () => {
    const unreadable: ImageAudit = { ...goodImage(), found: false, width: null, height: null };
    expect(scorePage(fullMeta(), unreadable).score).toBe(70);

    const svg: ImageAudit = { ...goodImage(), contentType: "image/svg+xml", format: "svg" };
    expect(scorePage(fullMeta(), svg).score).toBe(70);
  });

  it("fails production-urls (-15) on localhost canonical or relative og:image", () => {
    const localhostMeta = extractMeta(`
      <html><head>
        <title>T</title>
        <meta name="description" content="D" />
        <meta property="og:title" content="OT" />
        <meta property="og:description" content="OD" />
        <meta property="og:image" content="https://example.com/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="http://localhost:3000/" />
      </head></html>
    `);
    const { score, checks } = scorePage(localhostMeta, goodImage());
    expect(score).toBe(85);
    expect(checks.find((c) => c.id === "production-urls")?.passed).toBe(false);
  });

  it("fails twitter-card check when twitter:card has an invalid value", () => {
    const badCardMeta = extractMeta(`
      <html><head>
        <title>T</title>
        <meta name="description" content="D" />
        <meta property="og:title" content="OT" />
        <meta property="og:description" content="OD" />
        <meta property="og:image" content="https://example.com/og.png" />
        <meta name="twitter:card" content="large" />
        <link rel="canonical" href="https://example.com/" />
      </head></html>
    `);
    const { score, checks } = scorePage(badCardMeta, goodImage());
    expect(score).toBe(95);
    expect(checks.find((c) => c.id === "twitter-card")?.passed).toBe(false);
    expect(isValidTwitterCard("large")).toBe(false);
    expect(isValidTwitterCard("summary_large_image")).toBe(true);
  });

  it("deducts 5 when duplicate core tags exist", () => {
    const meta = extractMeta(`
      <html><head>
        <title>T</title>
        <meta name="description" content="D" />
        <meta property="og:title" content="OT1" />
        <meta property="og:title" content="OT2" />
        <meta property="og:description" content="OD" />
        <meta property="og:image" content="https://example.com/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="https://example.com/" />
      </head></html>
    `);
    expect(scorePage(meta, goodImage()).score).toBe(95);
  });
});

describe("statusFromScore & pageStatus", () => {
  it("classifies 90+ as pass, 70-89 as warn, below 70 as fail", () => {
    expect(statusFromScore(100)).toBe("pass");
    expect(statusFromScore(90)).toBe("pass");
    expect(statusFromScore(89)).toBe("warn");
    expect(statusFromScore(70)).toBe("warn");
    expect(statusFromScore(69)).toBe("fail");
    expect(statusFromScore(0)).toBe("fail");
  });

  it("caps status at warn when any error-level warning is present", () => {
    expect(pageStatus(100, [])).toBe("pass");
    expect(
      pageStatus(100, [{ severity: "warning", code: "og-image-too-large", message: "big" }]),
    ).toBe("pass");
    expect(
      pageStatus(100, [{ severity: "error", code: "og-image-not-found", message: "404 twitter" }]),
    ).toBe("warn");
    expect(
      pageStatus(50, [{ severity: "error", code: "og-image-not-found", message: "404" }]),
    ).toBe("fail");
  });
});

describe("hasDuplicateCoreTags", () => {
  it("returns false when each core tag appears at most once", () => {
    expect(hasDuplicateCoreTags(fullMeta())).toBe(false);
  });

  it("returns true when og:image is duplicated", () => {
    const meta = extractMeta(`
      <html><head>
        <meta property="og:image" content="a.png" />
        <meta property="og:image" content="b.png" />
      </head></html>
    `);
    expect(hasDuplicateCoreTags(meta)).toBe(true);
  });
});
