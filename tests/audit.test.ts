import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { audit, renderTerminal, renderPreviewHtml, auditFolder, NoHtmlFilesError } from "../src/index.js";

const execFileAsync = promisify(execFile);

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

async function tempSite(): Promise<string> {
  const dir = await makeTempDir("shipcard-");
  await fs.mkdir(path.join(dir, "blog"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), minimalHtml);
  await fs.writeFile(path.join(dir, "blog", "post.html"), minimalHtml);
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "ignored.html"), minimalHtml);
  await fs.writeFile(path.join(dir, "og.png"), TINY_PNG);
  return dir;
}

describe("audit() dispatch", () => {
  it("audits a single .html file with target.type === 'file' and single-page terminal output", async () => {
    const dir = await tempSite();
    const report = await audit(path.join(dir, "index.html"), { validateImages: false });
    expect(report.target.type).toBe("file");
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].path).toBe("/index.html");
    expect(report.summary.pagesScanned).toBe(1);

    const out = renderTerminal(report, { color: false });
    expect(out).toContain("Checks:");
    expect(out).toContain("Metadata:");
    expect(out).toContain("Platforms:");
    expect(out).not.toMatch(/\x1b\[/);
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
    const dir = await makeTempDir("shipcard-empty-");
    await expect(auditFolder(dir)).rejects.toBeInstanceOf(NoHtmlFilesError);
  });
});

describe("renderPreviewHtml", () => {
  it("embeds local images as data: URIs when embedLocalImages is true", async () => {
    const dir = await tempSite();
    const report = await audit(dir, { validateImages: true });
    const html = renderPreviewHtml(report, { embedLocalImages: true });
    expect(html).toMatch(/data:image\/png;base64,/);
  });

  it("uses each platform's own image probe (twitter:image on X vs og:image on Meta)", async () => {
    const dir = await makeTempDir("shipcard-preview-tw-");
    await fs.writeFile(path.join(dir, "og.png"), TINY_PNG);
    await fs.writeFile(path.join(dir, "tw.png"), TINY_PNG);
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<!doctype html><html><head>
        <title>Hi</title>
        <meta property="og:title" content="Hi" />
        <meta property="og:image" content="./og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="./tw.png" />
      </head></html>`,
    );
    const report = await audit(dir, { validateImages: true });
    const html = renderPreviewHtml(report);
    expect(html).toContain("og.png");
    expect(html).toContain("tw.png");
  });
});

describe("CLI smoke tests (dist/cli.js)", () => {
  const cliPath = path.resolve("dist/cli.js");

  it("handles --preview before target without consuming target as preview filename", async () => {
    const exists = await fs.stat(cliPath).then(() => true).catch(() => false);
    if (!exists) return;

    const dir = await tempSite();
    const cwd = await makeTempDir("shipcard-cli-cwd-");
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "--preview", "--offline", dir], {
      cwd,
    });
    expect(stdout).toContain("Preview written to shipcard-preview.html");
    const previewStat = await fs.stat(path.join(cwd, "shipcard-preview.html"));
    expect(previewStat.isFile()).toBe(true);
  });

  it("emits JSON error object when --json is passed with invalid args", async () => {
    const exists = await fs.stat(cliPath).then(() => true).catch(() => false);
    if (!exists) return;

    const err = await execFileAsync(process.execPath, [cliPath, "--json"]).catch((e) => e);
    expect(err.code).toBe(1);
    const parsed = JSON.parse(err.stdout);
    expect(parsed.tool).toBe("shipcard");
    expect(parsed.error.code).toBe("bad-args");
  });
});
