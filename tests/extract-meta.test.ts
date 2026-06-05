import { describe, it, expect } from "vitest";
import { extractMeta } from "../src/extract-meta.js";

const fullHtml = `
<!doctype html>
<html>
  <head>
    <title>Marketing Page</title>
    <meta name="description" content="Buy our thing." />
    <meta property="og:title" content="Marketing Page - OG" />
    <meta property="og:description" content="Buy our thing now." />
    <meta property="og:image" content="https://example.com/og.png" />
    <meta property="og:url" content="https://example.com/marketing" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Example" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Marketing Page - Twitter" />
    <meta name="twitter:description" content="Buy now on Twitter." />
    <meta name="twitter:image" content="https://example.com/twitter.png" />
    <link rel="canonical" href="https://example.com/marketing" />
  </head>
  <body></body>
</html>
`;

describe("extractMeta", () => {
  it("extracts all primary tags", () => {
    const meta = extractMeta(fullHtml);
    expect(meta.title).toBe("Marketing Page - OG");
    expect(meta.description).toBe("Buy our thing now.");
    expect(meta.image).toBe("https://example.com/og.png");
    expect(meta.url).toBe("https://example.com/marketing");
    expect(meta.type).toBe("website");
    expect(meta.siteName).toBe("Example");
    expect(meta.canonical).toBe("https://example.com/marketing");
    expect(meta.twitterCard).toBe("summary_large_image");
    expect(meta.twitterTitle).toBe("Marketing Page - Twitter");
    expect(meta.twitterDescription).toBe("Buy now on Twitter.");
    expect(meta.twitterImage).toBe("https://example.com/twitter.png");
  });

  it("falls back to <title> when og:title is missing", () => {
    const html = `<html><head><title>Plain Title</title></head></html>`;
    const meta = extractMeta(html);
    expect(meta.title).toBe("Plain Title");
    expect(meta.raw.titleTag).toBe("Plain Title");
    expect(meta.raw.openGraph["title"]).toBeUndefined();
  });

  it("falls back to meta description when og:description is missing", () => {
    const html = `<html><head><meta name="description" content="A page."></head></html>`;
    const meta = extractMeta(html);
    expect(meta.description).toBe("A page.");
  });

  it("falls back to twitter:image when og:image is missing", () => {
    const html = `<html><head><meta name="twitter:image" content="https://x.test/t.png"></head></html>`;
    const meta = extractMeta(html);
    expect(meta.image).toBe("https://x.test/t.png");
    expect(meta.twitterImage).toBe("https://x.test/t.png");
  });

  it("captures duplicate tags in raw buckets", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="One" />
        <meta property="og:title" content="Two" />
        <meta property="og:image" content="a.png" />
        <meta property="og:image" content="b.png" />
        <link rel="canonical" href="https://a.test/" />
        <link rel="canonical" href="https://b.test/" />
      </head></html>
    `;
    const meta = extractMeta(html);
    expect(meta.raw.openGraph["title"]).toEqual(["One", "Two"]);
    expect(meta.raw.openGraph["image"]).toEqual(["a.png", "b.png"]);
    expect(meta.raw.links["canonical"]).toEqual([
      "https://a.test/",
      "https://b.test/",
    ]);
  });

  it("returns nulls for an empty document", () => {
    const meta = extractMeta(`<html><head></head><body></body></html>`);
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.image).toBeNull();
    expect(meta.canonical).toBeNull();
    expect(meta.twitterCard).toBeNull();
  });

  it("trims whitespace from content attributes", () => {
    const html = `<html><head><meta property="og:title" content="  Spaced  " /></head></html>`;
    const meta = extractMeta(html);
    expect(meta.title).toBe("Spaced");
  });

  it("ignores empty content attributes", () => {
    const html = `<html><head><meta property="og:title" content="" /></head></html>`;
    const meta = extractMeta(html);
    expect(meta.title).toBeNull();
    expect(meta.raw.openGraph["title"]).toBeUndefined();
  });

  it("accepts og:* on name= and twitter:* on property= (real-world tolerance)", () => {
    const html = `
      <html><head>
        <meta name="og:title" content="OG via name" />
        <meta property="twitter:card" content="summary_large_image" />
      </head></html>
    `;
    const meta = extractMeta(html);
    expect(meta.title).toBe("OG via name");
    expect(meta.twitterCard).toBe("summary_large_image");
  });
});
