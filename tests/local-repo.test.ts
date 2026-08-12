import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { audit, auditFolder, extractMeta } from "../src/index.js";
import { resolveReference, localFileForHttpUrl } from "../src/utils.js";

// 1x1 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("local-first image resolution", () => {
  it("maps production https URLs to files under baseDir by pathname", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-local-"));
    await fs.mkdir(path.join(dir, "img"), { recursive: true });
    await fs.writeFile(path.join(dir, "img", "og.png"), TINY_PNG);

    const mapped = localFileForHttpUrl("https://example.com/img/og.png", dir);
    expect(mapped).toBe(path.join(dir, "img", "og.png"));

    const resolved = resolveReference("https://example.com/img/og.png", { baseDir: dir });
    expect(resolved.external).toBe(false);
    expect(resolved.resolved).toBe(path.join(dir, "img", "og.png"));
  });

  it("validates absolute production image URLs against local files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-abs-"));
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    await fs.writeFile(path.join(dir, "assets", "card.png"), TINY_PNG);
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<!doctype html><html><head>
        <title>Hi</title>
        <meta property="og:title" content="Hi" />
        <meta property="og:description" content="There" />
        <meta property="og:image" content="https://cdn.example.com/assets/card.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="https://example.com/" />
      </head></html>`,
    );

    const report = await audit(dir);
    const page = report.pages[0];
    expect(page.image?.found).toBe(true);
    expect(page.image?.external).toBe(false);
    expect(page.image?.width).toBe(1);
    expect(page.image?.height).toBe(1);
    expect(page.warnings.some((w) => w.code === "og-image-local-map")).toBe(true);
    const mismatch = page.warnings.find((w) => w.code === "og-image-dimensions-mismatch");
    expect(mismatch).toBeDefined();
    // file (1x1) is smaller than declared (1200x630) — should point at the likely cause
    expect(mismatch?.message).toContain("upscale");
    // readable check passes even though image is tiny
    expect(page.checks.find((c) => c.id === "image-readable")?.passed).toBe(true);
  });

  it("validates distinct twitter:image as well as og:image", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-tw-"));
    await fs.writeFile(path.join(dir, "og.png"), TINY_PNG);
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<!doctype html><html><head>
        <title>Hi</title>
        <meta property="og:title" content="Hi" />
        <meta property="og:description" content="There" />
        <meta property="og:image" content="./og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="./missing-twitter.png" />
        <link rel="canonical" href="https://example.com/" />
      </head></html>`,
    );

    const report = await audit(dir);
    const page = report.pages[0];
    expect(page.images?.length).toBe(2);
    expect(page.image?.found).toBe(true);
    expect(page.warnings.some((w) => w.message.includes("twitter:image") && w.code === "og-image-not-found")).toBe(
      true,
    );
  });
});

describe("meta outside head", () => {
  it("extracts og tags from body", () => {
    const meta = extractMeta(`
      <html><head><title>T</title></head>
      <body>
        <meta property="og:title" content="Body Title" />
        <meta property="og:image" content="https://example.com/og.png" />
      </body></html>
    `);
    expect(meta.raw.openGraph["title"]?.[0]).toBe("Body Title");
    expect(meta.image).toBe("https://example.com/og.png");
  });
});

describe("folder discovery", () => {
  it("auto-scans ./dist when the repo root has no HTML", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-root-"));
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "index.html"),
      `<html><head><title>Built</title><meta property="og:title" content="Built"/></head></html>`,
    );
    await fs.writeFile(path.join(root, "README.md"), "# app");

    const report = await auditFolder(root, { validateImages: false });
    expect(report.pages.map((p) => p.path)).toContain("/dist/index.html");
  });

  it("skips .git and coverage noise", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-noise-"));
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.mkdir(path.join(dir, "coverage"), { recursive: true });
    await fs.writeFile(path.join(dir, ".git", "x.html"), "<html></html>");
    await fs.writeFile(path.join(dir, "coverage", "x.html"), "<html></html>");
    await fs.writeFile(path.join(dir, "index.html"), "<html><head><title>Ok</title></head></html>");

    const report = await auditFolder(dir, { validateImages: false });
    expect(report.pages.map((p) => p.path)).toEqual(["/index.html"]);
  });

  it("scopes root-relative image resolution to a nested client/ build output (split builds)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-split-"));
    await fs.mkdir(path.join(root, "dist", "client"), { recursive: true });
    await fs.mkdir(path.join(root, "dist", "server"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "client", "og.png"), TINY_PNG);
    await fs.writeFile(
      path.join(root, "dist", "client", "index.html"),
      `<html><head>
        <title>Home</title>
        <meta property="og:title" content="Home"/>
        <meta property="og:description" content="D"/>
        <meta property="og:image" content="/og.png"/>
        <meta name="twitter:card" content="summary_large_image"/>
        <link rel="canonical" href="https://example.com/"/>
      </head></html>`,
    );

    const report = await auditFolder(path.join(root, "dist"));
    expect(report.pages.map((p) => p.path)).toEqual(["/client/index.html"]);
    expect(report.pages[0].image?.found).toBe(true);
    expect(report.pages[0].warnings.some((w) => w.code === "og-image-not-found")).toBe(false);
  });

  it("diagnoses a wrong-root miss for split shapes it doesn't recognize by name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-elsewhere-"));
    await fs.mkdir(path.join(root, "weirdname", "img"), { recursive: true });
    await fs.writeFile(path.join(root, "weirdname", "img", "og.png"), TINY_PNG);
    await fs.writeFile(
      path.join(root, "weirdname", "index.html"),
      `<html><head>
        <title>Home</title>
        <meta property="og:title" content="Home"/>
        <meta property="og:description" content="D"/>
        <meta property="og:image" content="/img/og.png"/>
        <meta name="twitter:card" content="summary_large_image"/>
        <link rel="canonical" href="https://example.com/"/>
      </head></html>`,
    );

    const report = await auditFolder(root);
    const warning = report.pages[0].warnings.find((w) => w.code === "og-image-found-elsewhere");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("./weirdname/img/og.png");
  });
});

describe("local URL warnings", () => {
  it("flags relative og:url and canonical", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-rel-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head>
        <title>T</title>
        <meta property="og:title" content="T"/>
        <meta property="og:url" content="/page"/>
        <link rel="canonical" href="/page"/>
      </head></html>`,
    );
    const report = await audit(dir, { validateImages: false });
    const codes = report.pages[0].warnings.map((w) => w.code);
    expect(codes).toContain("og-url-relative");
    expect(codes).toContain("canonical-relative");
  });
});
