import { describe, it, expect } from "vitest";
import { platformPreviews } from "../src/platforms.js";
import { extractMeta } from "../src/extract-meta.js";
import type { ImageAudit, PlatformPreview, Platform } from "../src/types.js";

function byPlatform(previews: PlatformPreview[], p: Platform): PlatformPreview {
  const found = previews.find((x) => x.platform === p);
  if (!found) throw new Error(`platform ${p} missing`);
  return found;
}

const longTitle = "T".repeat(120);
const longDesc = "D".repeat(300);

const richHtml = `
  <html><head>
    <title>Fallback Title</title>
    <meta name="description" content="Fallback description." />
    <meta property="og:title" content="${longTitle}" />
    <meta property="og:description" content="${longDesc}" />
    <meta property="og:image" content="https://example.com/og.png" />
    <meta property="og:url" content="https://example.com/" />
    <meta property="og:site_name" content="Example" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${longTitle}" />
    <meta name="twitter:description" content="${longDesc}" />
    <meta name="twitter:image" content="https://example.com/twitter.png" />
    <link rel="canonical" href="https://example.com/" />
  </head></html>
`;

function imageAudit(overrides: Partial<ImageAudit> = {}): ImageAudit {
  return {
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
    ...overrides,
  };
}

describe("platformPreviews — fallback chains", () => {
  it("X reads twitter:title first, falls back to og:title, then <title>", () => {
    const meta = extractMeta(richHtml);
    const x = byPlatform(platformPreviews(meta, imageAudit()), "x");
    expect(x.title.source).toBe("twitter:title");
    expect(x.title.value?.startsWith("T")).toBe(true);

    const noTwitter = extractMeta(`
      <html><head>
        <title>Fallback</title>
        <meta property="og:title" content="OG only" />
      </head></html>
    `);
    const x2 = byPlatform(platformPreviews(noTwitter, null), "x");
    expect(x2.title.source).toBe("og:title");
    expect(x2.title.value).toBe("OG only");
  });

  it("LinkedIn ignores twitter:* entirely", () => {
    const meta = extractMeta(richHtml);
    const li = byPlatform(platformPreviews(meta, imageAudit()), "linkedin");
    expect(li.title.source).toBe("og:title");
    expect(li.description.source).toBe("og:description");
    expect(li.image.source).toBe("og:image");
  });

  it("Meta (Facebook) ignores twitter:* entirely", () => {
    const meta = extractMeta(richHtml);
    const fb = byPlatform(platformPreviews(meta, imageAudit()), "meta");
    expect(fb.title.source).toBe("og:title");
    expect(fb.image.source).toBe("og:image");
  });
});

describe("platformPreviews — truncation", () => {
  it("X truncates titles to ~70 chars and marks truncated=true", () => {
    const meta = extractMeta(richHtml);
    const x = byPlatform(platformPreviews(meta, imageAudit()), "x");
    expect(x.title.truncated).toBe(true);
    expect(x.title.value?.length).toBeLessThanOrEqual(70);
    expect(x.title.value?.endsWith("…")).toBe(true);
  });

  it("Discord allows much longer titles (256 chars) without truncating", () => {
    const meta = extractMeta(richHtml);
    const d = byPlatform(platformPreviews(meta, imageAudit()), "discord");
    // longTitle is 120 chars, under Discord's 256 limit
    expect(d.title.truncated).toBe(false);
  });

  it("iMessage truncates titles aggressively (60 chars)", () => {
    const meta = extractMeta(richHtml);
    const im = byPlatform(platformPreviews(meta, imageAudit()), "imessage");
    expect(im.title.truncated).toBe(true);
    expect(im.title.value?.length).toBeLessThanOrEqual(60);
  });
});

describe("platformPreviews — X card layout", () => {
  it("renders large card when twitter:card=summary_large_image and image is big enough", () => {
    const meta = extractMeta(richHtml);
    const x = byPlatform(platformPreviews(meta, imageAudit()), "x");
    expect(x.cardLayout).toBe("large");
    expect(x.warnings.find((w) => w.code === "x-missing-card")).toBeUndefined();
  });

  it("warns when twitter:card is missing", () => {
    const meta = extractMeta(`
      <html><head>
        <meta property="og:title" content="T" />
        <meta property="og:image" content="https://example.com/og.png" />
      </head></html>
    `);
    const x = byPlatform(platformPreviews(meta, imageAudit()), "x");
    expect(x.warnings.some((w) => w.code === "x-missing-card")).toBe(true);
  });

  it("falls back to summary card when image is too small for summary_large_image", () => {
    const meta = extractMeta(richHtml);
    const small = imageAudit({ width: 200, height: 100 });
    const x = byPlatform(platformPreviews(meta, small), "x");
    expect(x.cardLayout).toBe("summary");
    expect(x.warnings.some((w) => w.code === "x-image-too-small")).toBe(true);
  });
});

describe("platformPreviews — Meta card layout", () => {
  it("renders large card when image meets 600x315", () => {
    const meta = extractMeta(richHtml);
    const fb = byPlatform(platformPreviews(meta, imageAudit()), "meta");
    expect(fb.cardLayout).toBe("large");
  });

  it("falls back to small thumbnail card for smaller images", () => {
    const meta = extractMeta(richHtml);
    const fb = byPlatform(platformPreviews(meta, imageAudit({ width: 400, height: 200 })), "meta");
    expect(fb.cardLayout).toBe("summary");
    expect(fb.warnings.some((w) => w.code === "meta-image-small-card")).toBe(true);
  });

  it("renders no card at all when og:image is missing", () => {
    const meta = extractMeta(`<html><head><title>T</title></head></html>`);
    const fb = byPlatform(platformPreviews(meta, null), "meta");
    expect(fb.cardLayout).toBe("none");
  });
});

describe("platformPreviews — Discord card layout", () => {
  it("upgrades to large embed when twitter:card=summary_large_image", () => {
    const meta = extractMeta(richHtml);
    const d = byPlatform(platformPreviews(meta, imageAudit()), "discord");
    expect(d.cardLayout).toBe("large");
  });

  it("renders inline thumbnail without summary_large_image and warns about it", () => {
    const meta = extractMeta(`
      <html><head>
        <meta property="og:title" content="T" />
        <meta property="og:image" content="https://example.com/og.png" />
      </head></html>
    `);
    const d = byPlatform(platformPreviews(meta, imageAudit()), "discord");
    expect(d.cardLayout).toBe("inline");
    expect(d.warnings.some((w) => w.code === "discord-small-embed")).toBe(true);
  });
});

describe("platformPreviews — emits all supported platforms", () => {
  it("always returns the supported platforms in order (11 as of 0.3.0)", () => {
    const meta = extractMeta(`<html><head></head></html>`);
    const previews = platformPreviews(meta, null);
    expect(previews.map((p) => p.platform)).toEqual([
      "meta",
      "linkedin",
      "x",
      "pinterest",
      "slack",
      "discord",
      "whatsapp",
      "telegram",
      "bluesky",
      "mastodon",
      "imessage",
    ]);
  });
});

describe("platformPreviews — new platforms (Pinterest / WhatsApp / etc.)", () => {
  it("Pinterest warns on non-tall images and prefers og:image", () => {
    const meta = extractMeta(`<html><head><meta property="og:image" content="https://ex.com/og.png" /></head></html>`);
    const p = byPlatform(platformPreviews(meta, imageAudit({ width: 1200, height: 630 })), "pinterest");
    expect(p.image.source).toBe("og:image");
    expect(p.warnings.some((w) => w.code === "pinterest-image-not-vertical")).toBe(true);
  });

  it("WhatsApp surfaces size guidance when image >600KB (via probe)", () => {
    const meta = extractMeta(`<html><head><meta property="og:image" content="https://ex.com/big.jpg" /></head></html>`);
    const big = imageAudit({ sizeBytes: 800 * 1024, width: 1200, height: 630 });
    const wa = byPlatform(platformPreviews(meta, big), "whatsapp");
    expect(wa.warnings.some((w) => w.code === "whatsapp-image-too-large")).toBe(true);
  });
});
