import { describe, it, expect } from "vitest";
import { scorePage, statusFromScore, hasDuplicateCoreTags } from "../src/score.js";
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
  it("gives a perfect 100 with full metadata and a good image", () => {
    const { score, checks } = scorePage(fullMeta(), goodImage());
    expect(score).toBe(100);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  it("only credits the no-duplicate-tags check for empty metadata", () => {
    // An empty document has no tags, therefore no duplicates — the only
    // check that passes is "no duplicate core tags" (weight 5).
    const { score, checks } = scorePage(emptyMeta(), null);
    expect(score).toBe(5);
    const passed = checks.filter((c) => c.passed).map((c) => c.id);
    expect(passed).toEqual(["no-duplicate-core-tags"]);
  });

  it("dings score by 10 for an undersized image", () => {
    const meta = fullMeta();
    const img: ImageAudit = { ...goodImage(), width: 800, height: 420 };
    const { score } = scorePage(meta, img);
    expect(score).toBe(90);
  });

  it("dings 15 + 10 when image is unreadable (no width/height)", () => {
    const meta = fullMeta();
    const img: ImageAudit = {
      ...goodImage(),
      found: false,
      width: null,
      height: null,
    };
    const { score } = scorePage(meta, img);
    // -15 (readable) -10 (dimensions) = -25
    expect(score).toBe(75);
  });

  it("dings 5 when duplicate core tags exist", () => {
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
    const { score } = scorePage(meta, goodImage());
    expect(score).toBe(95);
  });

  it("only counts og:title for the og-title check (not the <title> fallback)", () => {
    const meta = extractMeta(`<html><head><title>T</title></head></html>`);
    const { checks } = scorePage(meta, null);
    const titleCheck = checks.find((c) => c.id === "title");
    const ogTitleCheck = checks.find((c) => c.id === "og-title");
    expect(titleCheck?.passed).toBe(true);
    expect(ogTitleCheck?.passed).toBe(false);
  });
});

describe("statusFromScore", () => {
  it("classifies 90+ as ready", () => {
    expect(statusFromScore(100)).toBe("ready");
    expect(statusFromScore(90)).toBe("ready");
  });
  it("classifies 70-89 as warning", () => {
    expect(statusFromScore(89)).toBe("warning");
    expect(statusFromScore(70)).toBe("warning");
  });
  it("classifies below 70 as fail", () => {
    expect(statusFromScore(69)).toBe("fail");
    expect(statusFromScore(0)).toBe("fail");
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
