import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { audit } from "../src/index.js";
import { renderTerminal } from "../src/render-terminal.js";
import { platformPreviews } from "../src/platforms.js";
import { extractMeta } from "../src/extract-meta.js";
import type { ImageAudit } from "../src/types.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("external host messaging", () => {
  it("explains external hosts under --offline and does not fetch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-ext-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head>
        <title>T</title>
        <meta property="og:title" content="T"/>
        <meta property="og:description" content="D"/>
        <meta property="og:image" content="https://www.forsythofdenny.co.uk/og.png"/>
        <meta name="twitter:card" content="summary_large_image"/>
        <link rel="canonical" href="https://example.com/"/>
      </head></html>`,
    );

    const report = await audit(dir, { offline: true });
    const codes = report.pages[0].warnings.map((w) => w.code);
    expect(codes).toContain("og-image-offline");
    expect(report.pages[0].warnings.some((w) => w.message.includes("www.forsythofdenny.co.uk"))).toBe(true);
    expect(report.pages[0].warnings.some((w) => w.message.includes("no matching file"))).toBe(true);
    expect(report.pages[0].image?.found).toBe(false);
  });
});

describe("shared leak grouping", () => {
  it("groups identical leaks across many pages", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-group-"));
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(dir, `p${i}.html`),
        `<html><head>
          <title>P${i}</title>
          <meta property="og:title" content="P${i}"/>
          <meta property="og:image" content="https://cdn.example.com/missing.png"/>
        </head></html>`,
      );
    }

    const report = await audit(dir, { offline: true });
    const out = renderTerminal(report);
    expect(out).toContain("Shared leaks:");
    expect(out).toMatch(/5 pages —/);
    // should not repeat a full per-page leak block five times for the same message
    const perPageLeakHeaders = out.split("\n").filter((l) => l.startsWith("/p") && l.endsWith(".html"));
    // page table lines exist; detailed sections should be collapsed via shared
    expect(out.match(/Shared leaks:/g)?.length).toBe(1);
  });
});

describe("platform why inline", () => {
  it("includes a reason for warning platforms in terminal-style table", () => {
    const meta = extractMeta(`<html><head>
      <title>T</title>
      <meta property="og:title" content="T"/>
      <meta property="og:image" content="https://example.com/og.png"/>
    </head></html>`);
    const image: ImageAudit = {
      source: "https://example.com/og.png",
      resolvedSource: "https://example.com/og.png",
      found: true,
      external: true,
      contentType: "image/png",
      width: 100,
      height: 100,
      sizeBytes: 1000,
      format: "png",
      warnings: [],
    };
    const platforms = platformPreviews(meta, image);
    // Build a fake single-page report through renderTerminal is heavy; call the
    // public render with a minimal folder report containing platforms.
    const report = {
      tool: "shipcard" as const,
      version: "0.1.1",
      createdAt: new Date().toISOString(),
      target: { type: "url" as const, input: "https://example.com" },
      summary: { score: 50, pagesScanned: 1, ready: 0, warnings: 0, failed: 1 },
      pages: [
        {
          path: "https://example.com",
          source: "https://example.com",
          score: 50,
          status: "fail" as const,
          meta,
          image,
          checks: [],
          warnings: [],
          platforms,
        },
      ],
    };
    const out = renderTerminal(report);
    expect(out).toContain("Platform previews:");
    // LinkedIn should warn about small image and reason should appear inline
    expect(out).toMatch(/LinkedIn.*—/);
  });
});

describe("offline still maps local path matches", () => {
  it("reads production URL from disk under --offline", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-off-"));
    await fs.mkdir(path.join(dir, "img"), { recursive: true });
    await fs.writeFile(path.join(dir, "img", "og.png"), TINY_PNG);
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head>
        <title>T</title>
        <meta property="og:title" content="T"/>
        <meta property="og:description" content="D"/>
        <meta property="og:image" content="https://cdn.example.com/img/og.png"/>
        <meta name="twitter:card" content="summary_large_image"/>
        <link rel="canonical" href="https://example.com/"/>
      </head></html>`,
    );

    const report = await audit(dir, { offline: true });
    expect(report.pages[0].image?.found).toBe(true);
    expect(report.pages[0].image?.external).toBe(false);
    expect(report.pages[0].warnings.some((w) => w.code === "og-image-local-map")).toBe(true);
    expect(report.pages[0].warnings.some((w) => w.code === "og-image-offline")).toBe(false);
  });
});
