import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { audit } from "../src/index.js";
import { auditFolder, NoHtmlFilesError } from "../src/audit-folder.js";
import { renderPreviewHtml } from "../src/preview-html.js";

const minimalHtml = `<!doctype html>
<html><head>
  <title>Hello</title>
  <meta property="og:title" content="Hello" />
  <meta property="og:description" content="World" />
  <meta property="og:image" content="./og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href="https://example.com/" />
</head><body></body></html>`;

// 1x1 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function tempSite(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-"));
  await fs.mkdir(path.join(dir, "blog"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), minimalHtml);
  await fs.writeFile(path.join(dir, "blog", "post.html"), minimalHtml);
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "ignored.html"), minimalHtml);
  await fs.writeFile(path.join(dir, "og.png"), TINY_PNG);
  return dir;
}

describe("audit() dispatch", () => {
  it("audits a single .html file", async () => {
    const dir = await tempSite();
    const report = await audit(path.join(dir, "index.html"), { validateImages: false });
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].path).toBe("/index.html");
    expect(report.summary.pagesScanned).toBe(1);
  });

  it("audits a folder (skips node_modules)", async () => {
    const dir = await tempSite();
    const report = await audit(dir, { validateImages: false });
    expect(report.pages.map((p) => p.path).sort()).toEqual(["/blog/post.html", "/index.html"]);
    expect(report.target.type).toBe("folder");
  });

  it("throws a clear error for missing targets", async () => {
    await expect(audit("/tmp/shipcard-does-not-exist-xyz")).rejects.toThrow(/Target not found/);
  });
});

describe("auditFolder walk", () => {
  it("throws NoHtmlFilesError on empty folders", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-empty-"));
    await expect(auditFolder(dir)).rejects.toBeInstanceOf(NoHtmlFilesError);
  });
});

describe("renderPreviewHtml --embed", () => {
  it("embeds local images as data: URIs", async () => {
    const dir = await tempSite();
    const report = await audit(dir, { validateImages: true });
    const html = renderPreviewHtml(report, { embedLocalImages: true });
    expect(html).toContain("data:image/");
    expect(html).toMatch(/data:image\/png;base64,/);
  });
});
