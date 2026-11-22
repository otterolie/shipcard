import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  audit,
  auditFolder,
  auditHtml,
  auditSitemap,
  fixesForPage,
  parseSitemapXml,
  renderPreviewHtml,
  renderTerminal,
  validateImage,
} from "../src/index.js";
import { isSitemapUrl, matchesGlob } from "../src/utils.js";

const execFileAsync = promisify(execFile);

/** Build a valid minimal PNG header with the given width and height (readable by image-size). */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type (RGB)
  return buf;
}

const GOOD_PNG = fakePng(1200, 630);
const SQUARE_PNG = fakePng(1200, 1200);

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("glob matching & --ignore", () => {
  it("matches basenames, nested paths, and wildcards", () => {
    expect(matchesGlob("/404.html", "404.html")).toBe(true);
    expect(matchesGlob("/en/404.html", "404.html")).toBe(true);
    expect(matchesGlob("/google123abc.html", "google*.html")).toBe(true);
    expect(matchesGlob("/admin/users/index.html", "/admin/**")).toBe(true);
    expect(matchesGlob("/admin/index.html", "admin/**")).toBe(true);
    expect(matchesGlob("/blog/2026/draft.html", "/blog/*/draft.html")).toBe(true);
    expect(matchesGlob("/blog/a/b/draft.html", "/blog/*/draft.html")).toBe(false);
    expect(matchesGlob("/index.html", "404.html")).toBe(false);
  });

  it("skips ignored files and redirect stubs in auditFolder", async () => {
    const dir = await makeTempDir("shipcard-ignore-");
    await fs.mkdir(path.join(dir, "admin"), { recursive: true });
    await fs.writeFile(path.join(dir, "og.png"), GOOD_PNG);
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head>
        <title>Home</title>
        <meta name="description" content="Home desc" />
        <meta property="og:title" content="Home" />
        <meta property="og:description" content="Home desc" />
        <meta property="og:image" content="https://example.com/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="https://example.com/" />
      </head></html>`,
    );
    await fs.writeFile(path.join(dir, "404.html"), `<html><head><title>404</title></head></html>`);
    await fs.writeFile(path.join(dir, "admin", "secret.html"), `<html><head></head></html>`);
    await fs.writeFile(
      path.join(dir, "old.html"),
      `<html><head><meta http-equiv="refresh" content="0;url=/new"></head></html>`,
    );

    const report = await auditFolder(dir, {
      offline: true,
      ignore: ["404.html", "/admin/**"],
    });
    expect(report.pages.map((p) => p.path)).toEqual(["/index.html"]);
    expect(report.summary.score).toBe(100);
    expect(report.summary.skipped).toBe(3);
    expect(report.skipped).toEqual([
      { path: "/404.html", reason: "ignored" },
      { path: "/admin/secret.html", reason: "ignored" },
      { path: "/old.html", reason: "redirect" },
    ]);

    const withRedirects = await auditFolder(dir, {
      offline: true,
      ignore: ["404.html", "/admin/**"],
      includeRedirects: true,
    });
    expect(withRedirects.pages.map((p) => p.path)).toEqual(["/index.html", "/old.html"]);
  });
});

describe("image aspect ratio & AVIF checks", () => {
  it("accepts 1200x630 without aspect ratio warning", async () => {
    const dir = await makeTempDir("shipcard-ar-ok-");
    await fs.writeFile(path.join(dir, "og.png"), GOOD_PNG);
    const img = await validateImage("./og.png", { baseDir: dir });
    expect(img.width).toBe(1200);
    expect(img.height).toBe(630);
    expect(img.warnings.some((w) => w.code === "og-image-aspect-ratio")).toBe(false);
  });

  it("warns on square 1200x1200 og:image but allows square twitter:image when twitter:card=summary", async () => {
    const dir = await makeTempDir("shipcard-ar-sq-");
    await fs.writeFile(path.join(dir, "og.png"), SQUARE_PNG);
    await fs.writeFile(path.join(dir, "tw.png"), SQUARE_PNG);
    const html = `<html><head>
      <title>T</title>
      <meta property="og:title" content="T" />
      <meta property="og:description" content="D" />
      <meta property="og:image" content="./og.png" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:image" content="./tw.png" />
    </head></html>`;

    const page = await auditHtml(html, { source: "index.html", path: "/index.html", baseDir: dir });
    const ogImg = page.images?.find((i) => i.source === "./og.png");
    const twImg = page.images?.find((i) => i.source === "./tw.png");
    expect(ogImg?.warnings.some((w) => w.code === "og-image-aspect-ratio")).toBe(true);
    expect(twImg?.warnings.some((w) => w.code === "og-image-aspect-ratio")).toBe(false);
    expect(fixesForPage(page).some((f) => f.id === "fix-og-image-aspect-ratio")).toBe(true);
  });

  it("warns when image content-type is image/avif", async () => {
    const mockFetch = async () =>
      new Response(GOOD_PNG, {
        status: 200,
        headers: { "content-type": "image/avif" },
      });
    const img = await validateImage("https://example.com/card.avif", {
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(img.warnings.some((w) => w.code === "og-image-avif")).toBe(true);
  });
});

describe("late-in-HTML meta tag detection", () => {
  it("warns when social meta tags appear past 50 KB into the HTML", async () => {
    const padding = "/* " + "x".repeat(55 * 1024) + " */";
    const html = `<!doctype html><html><head>
      <style>${padding}</style>
      <title>Late</title>
      <meta property="og:title" content="Late" />
      <meta property="og:image" content="https://example.com/og.png" />
    </head></html>`;

    const page = await auditHtml(html, {
      source: "index.html",
      path: "/index.html",
      validateImages: false,
    });
    expect(page.warnings.some((w) => w.code === "meta-too-late")).toBe(true);
    expect(fixesForPage(page).some((f) => f.id === "fix-meta-too-late")).toBe(true);
  });

  it("does not warn for normal small <head> documents", async () => {
    const html = `<html><head><title>Fast</title><meta property="og:title" content="Fast" /></head></html>`;
    const page = await auditHtml(html, {
      source: "index.html",
      path: "/index.html",
      validateImages: false,
    });
    expect(page.warnings.some((w) => w.code === "meta-too-late")).toBe(false);
  });
});

describe("cross-page duplicate title/description detection", () => {
  it("flags pages sharing identical title or description in folder audits", async () => {
    const dir = await makeTempDir("shipcard-dupes-");
    for (const name of ["index.html", "about.html", "pricing.html"]) {
      await fs.writeFile(
        path.join(dir, name),
        `<html><head>
          <title>Acme Corp</title>
          <meta property="og:title" content="Acme Corp" />
          <meta property="og:description" content="Same description everywhere" />
        </head></html>`,
      );
    }

    const report = await auditFolder(dir, { validateImages: false });
    expect(report.siteWarnings?.some((w) => w.code === "duplicate-site-title")).toBe(true);
    expect(report.siteWarnings?.some((w) => w.code === "duplicate-site-description")).toBe(true);

    const terminal = renderTerminal(report, { color: false });
    expect(terminal).toContain("Site issues:");
    expect(terminal).toContain('3 pages share the same title: "Acme Corp"');

    const preview = renderPreviewHtml(report);
    expect(preview).toContain("Site-wide issues");
  });
});

describe("sitemap parsing & auditing", () => {
  it("recognizes sitemap URLs and parses urlset / sitemapindex XML", () => {
    expect(isSitemapUrl("https://example.com/sitemap.xml")).toBe(true);
    expect(isSitemapUrl("https://example.com/sitemap-index.xml?v=1")).toBe(true);
    expect(isSitemapUrl("https://example.com/about")).toBe(false);

    const urlset = parseSitemapXml(`<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/blog?a=1&amp;b=2</loc></url>
      </urlset>`);
    expect(urlset.urls).toEqual(["https://example.com/", "https://example.com/blog?a=1&b=2"]);
    expect(urlset.sitemaps).toEqual([]);

    const index = parseSitemapXml(`<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap>
      </sitemapindex>`);
    expect(index.sitemaps).toEqual(["https://example.com/sitemap-0.xml"]);
  });

  it("audits sitemap index + pages, respects ignore/maxPages, and deduplicates image fetches", async () => {
    let imageFetches = 0;
    const routes: Record<string, { body: string | Buffer; contentType: string }> = {
      "https://example.com/sitemap.xml": {
        contentType: "application/xml",
        body: `<sitemapindex><sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      },
      "https://example.com/sitemap-pages.xml": {
        contentType: "application/xml",
        body: `<urlset>
          <url><loc>https://example.com/</loc></url>
          <url><loc>https://example.com/about</loc></url>
          <url><loc>https://example.com/admin/panel</loc></url>
          <url><loc>https://example.com/extra</loc></url>
        </urlset>`,
      },
      "https://example.com/": {
        contentType: "text/html",
        body: `<html><head>
          <title>Home</title>
          <meta name="description" content="Home page" />
          <meta property="og:title" content="Home" />
          <meta property="og:description" content="Home page" />
          <meta property="og:image" content="https://example.com/og.png" />
          <meta name="twitter:card" content="summary_large_image" />
          <link rel="canonical" href="https://example.com/" />
        </head></html>`,
      },
      "https://example.com/about": {
        contentType: "text/html",
        body: `<html><head>
          <title>About</title>
          <meta name="description" content="About page" />
          <meta property="og:title" content="About" />
          <meta property="og:description" content="About page" />
          <meta property="og:image" content="https://example.com/og.png" />
          <meta name="twitter:card" content="summary_large_image" />
          <link rel="canonical" href="https://example.com/about" />
        </head></html>`,
      },
      "https://example.com/og.png": {
        contentType: "image/png",
        body: GOOD_PNG,
      },
    };

    const mockFetch = async (input: string | URL) => {
      const url = String(input);
      if (url === "https://example.com/og.png") imageFetches++;
      const entry = routes[url];
      if (!entry) return new Response("Not Found", { status: 404 });
      return new Response(entry.body, {
        status: 200,
        headers: { "content-type": entry.contentType },
      });
    };

    const report = await auditSitemap("https://example.com/sitemap.xml", {
      fetchImpl: mockFetch as typeof fetch,
      ignore: ["/admin/**"],
      maxPages: 2,
    });

    expect(report.target.type).toBe("sitemap");
    expect(report.pages).toHaveLength(2);
    expect(report.summary.score).toBe(100);
    expect(report.skipped).toEqual([{ path: "https://example.com/admin/panel", reason: "ignored" }]);
    // Shared og.png across both pages should only be fetched once!
    expect(imageFetches).toBe(1);
  });
});

describe("--failures-only terminal rendering & CLI flags", () => {
  it("hides passing pages when failuresOnly is true", async () => {
    const dir = await makeTempDir("shipcard-fo-");
    await fs.writeFile(path.join(dir, "og.png"), GOOD_PNG);
    await fs.writeFile(
      path.join(dir, "good.html"),
      `<html><head>
        <title>Good</title>
        <meta name="description" content="Good desc" />
        <meta property="og:title" content="Good" />
        <meta property="og:description" content="Good desc" />
        <meta property="og:image" content="https://example.com/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="https://example.com/good" />
      </head></html>`,
    );
    await fs.writeFile(path.join(dir, "bad.html"), `<html><head><title>Bad</title></head></html>`);

    const report = await audit(dir, { offline: true });
    const out = renderTerminal(report, { color: false, failuresOnly: true });
    expect(out).toContain("/bad.html");
    expect(out).not.toMatch(/✓ \/good\.html/);
    expect(out).toContain("1 passing page(s) hidden (--failures-only).");
  });

  it("supports --ignore and --failures-only via CLI", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const exists = await fs.stat(cliPath).then(() => true).catch(() => false);
    if (!exists) return;

    const dir = await makeTempDir("shipcard-cli-v03-");
    await fs.writeFile(path.join(dir, "og.png"), GOOD_PNG);
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head>
        <title>Home</title>
        <meta name="description" content="Desc" />
        <meta property="og:title" content="Home" />
        <meta property="og:description" content="Desc" />
        <meta property="og:image" content="https://example.com/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="https://example.com/" />
      </head></html>`,
    );
    await fs.writeFile(path.join(dir, "404.html"), `<html><head><title>404</title></head></html>`);

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      dir,
      "--offline",
      "--ignore",
      "404.html",
      "--failures-only",
    ]);
    expect(stdout).toContain("All 1 pages passed.");
    expect(stdout).toContain("1 skipped");
  });

  it("tracks minScore and exits 1 with --fail-on fail even when mean score is high", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const exists = await fs.stat(cliPath).then(() => true).catch(() => false);
    if (!exists) return;

    const dir = await makeTempDir("shipcard-fail-on-");
    await fs.writeFile(path.join(dir, "og.png"), GOOD_PNG);
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(dir, `ok-${i}.html`),
        `<html><head>
          <title>Page ${i}</title>
          <meta name="description" content="Desc ${i}" />
          <meta property="og:title" content="Page ${i}" />
          <meta property="og:description" content="Desc ${i}" />
          <meta property="og:image" content="https://example.com/og.png" />
          <meta name="twitter:card" content="summary_large_image" />
          <link rel="canonical" href="https://example.com/ok-${i}" />
        </head></html>`,
      );
    }
    await fs.writeFile(path.join(dir, "broken.html"), `<html><head></head></html>`);

    const report = await audit(dir, { offline: true });
    expect(report.summary.score).toBeGreaterThanOrEqual(80);
    expect(report.summary.minScore).toBeLessThan(20);

    const err = await execFileAsync(process.execPath, [
      cliPath,
      dir,
      "--offline",
      "--fail-on",
      "fail",
    ]).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stdout).toContain("--fail-on fail");
  });
});
