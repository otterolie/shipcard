#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { auditUrl } from "./audit-url.js";
import { auditFolder, NoHtmlFilesError } from "./audit-folder.js";
import { renderTerminal } from "./render-terminal.js";
import { renderPreviewHtml } from "./preview-html.js";
import { isHttpUrl } from "./utils.js";
import { VERSION } from "./version.js";
import type { AuditReport } from "./types.js";

const DEFAULT_PREVIEW_PATH = "shipcard-preview.html";

type CliOptions = {
  json?: boolean;
  failBelow?: string;
  timeout?: string;
  // commander turns --no-images into images: false
  images?: boolean;
  // --preview with no arg → true; --preview <file> → string
  preview?: boolean | string;
  /** Write the main report (json or terminal text) to this file instead of (or in addition to) stdout. */
  output?: string;
  /** Watch the target for changes and re-run (requires chokidar). */
  watch?: boolean;
  /** For --preview on folder targets: embed local images as data:base64 (see types). */
  embed?: boolean;
};

async function run(target: string, opts: CliOptions): Promise<number> {
  const failBelow = parseFailBelow(opts.failBelow);
  if (failBelow instanceof Error) {
    printError(failBelow.message);
    return 1;
  }

  const timeoutMs = opts.timeout ? Number(opts.timeout) : undefined;
  const validateImages = opts.images !== false;

  const embedLocalImages = !!opts.embed;

  let report: AuditReport;
  try {
    if (isHttpUrl(target)) {
      report = await auditUrl(target, { version: VERSION, timeoutMs, validateImages, embedLocalImages });
    } else {
      // Support single .html file, folder, or "-" for stdin
      if (target === "-") {
        // stdin html
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const html = Buffer.concat(chunks).toString("utf8") || "<html><head></head><body></body></html>";
        const page = await (await import("./audit-html.js")).auditHtml(html, {
          source: "<stdin>",
          path: "/stdin.html",
          ...{ validateImages, embedLocalImages, timeoutMs },
        });
        const { summarize } = await import("./summarize.js");
        report = {
          tool: "shipcard",
          version: VERSION,
          createdAt: new Date().toISOString(),
          target: { type: "folder", input: "-" },
          summary: summarize([page]),
          pages: [page],
        };
      } else {
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) {
          if (opts.json) {
            const e = { tool: "shipcard", version: VERSION, error: { code: "target-not-found", message: `Target not found: ${target}` } };
            process.stdout.write(JSON.stringify(e, null, 2) + "\n");
          } else {
            printError(`Target not found: ${target}`);
            printHint("Pass a URL, a folder (./dist), a .html file, or - for stdin.");
          }
          return 1;
        }
        if (stat.isFile() && /\.(html|htm)$/i.test(target)) {
          // single file -> treat as 1-page report (reuse auditHtml + wrap)
          const html = await fs.readFile(target, "utf8");
          const page = await (await import("./audit-html.js")).auditHtml(html, {
            source: target,
            path: "/" + path.basename(target),
            sourceFile: target,
            baseDir: path.dirname(target),
            validateImages,
            embedLocalImages,
            timeoutMs,
          });
          const { summarize } = await import("./summarize.js");
          report = {
            tool: "shipcard",
            version: VERSION,
            createdAt: new Date().toISOString(),
            target: { type: "folder", input: target },
            summary: summarize([page]),
            pages: [page],
          };
        } else if (stat.isDirectory()) {
          report = await auditFolder(path.resolve(target), {
            version: VERSION,
            timeoutMs,
            validateImages,
            embedLocalImages,
          });
        } else {
          printError(`Target is not a directory or .html file: ${target}`);
          return 1;
        }
      }
    }
  } catch (err) {
    if (err instanceof NoHtmlFilesError) {
      if (opts.json) {
        const errReport = {
          tool: "shipcard",
          version: VERSION,
          error: {
            code: "no-html-files",
            message: err.message,
            hint: "Point shipcard at a built site folder. Common targets: ./dist, ./out, ./build, ./public.",
          },
        };
        process.stdout.write(JSON.stringify(errReport, null, 2) + "\n");
      } else {
        printError(err.message);
        printHint("Point shipcard at a built site folder. Common targets: ./dist, ./out, ./build, ./public.");
      }
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      const errReport = {
        tool: "shipcard",
        version: VERSION,
        error: { code: "audit-failed", message: msg },
      };
      process.stdout.write(JSON.stringify(errReport, null, 2) + "\n");
    } else {
      printError(`Audit failed: ${msg}`);
    }
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderTerminal(report));
  }

  // --output support (write the primary report artifact)
  if (opts.output) {
    try {
      const content = opts.json
        ? JSON.stringify(report, null, 2) + "\n"
        : renderTerminal(report);
      await fs.writeFile(path.resolve(opts.output), content, "utf8");
      if (!opts.json) {
        process.stdout.write(pc.dim(`\nReport written to ${opts.output}\n`));
      }
    } catch (err) {
      printError(`Could not write --output: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (opts.preview) {
    const previewPath = typeof opts.preview === "string" ? opts.preview : DEFAULT_PREVIEW_PATH;
    try {
      await fs.writeFile(path.resolve(previewPath), renderPreviewHtml(report, { embedLocalImages: !!opts.embed }), "utf8");
      if (!opts.json) {
        process.stdout.write(pc.dim(`\nPreview written to ${previewPath}\n`));
      }
    } catch (err) {
      printError(`Could not write preview: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (failBelow !== null && report.summary.score < failBelow) {
    if (!opts.json) {
      process.stdout.write(
        pc.red(`\nShip blocked: score ${report.summary.score} is below threshold ${failBelow}.\n`),
      );
    }
    return 1;
  }

  if (opts.watch) {
    const chokidarMod: any = await import("chokidar");
    const chokidar = chokidarMod.default || chokidarMod;
    const toWatch = target === "-" ? process.cwd() : target;
    const watcher = chokidar.watch(toWatch, {
      ignoreInitial: true,
      ignored: /(^|[/\\])node_modules([/\\]|$)/,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    process.stderr.write(pc.dim(`[watch] Watching ${toWatch} for changes (Ctrl-C to stop)\n`));
    watcher.on("all", async (event: string, changedPath?: string) => {
      if (changedPath && changedPath.includes("node_modules")) return;
      process.stderr.write(pc.dim(`[watch] ${event} ${changedPath || ""} — re-running audit...\n`));
      try {
        // One-shot re-run (watch flag off to avoid nesting)
        await run(target, { ...opts, watch: false } as any);
      } catch (e) {
        // errors already printed by inner run
      }
    });
    // Keep the process alive for the watcher
    await new Promise(() => {});
  }

  return 0;
}

function parseFailBelow(value: string | undefined): number | null | Error {
  if (value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || n > 100) {
    return new Error(`--fail-below must be a number between 0 and 100, got "${value}".`);
  }
  return n;
}

function printError(message: string): void {
  process.stderr.write(pc.red(`shipcard: ${message}\n`));
}

function printHint(message: string): void {
  process.stderr.write(pc.dim(`hint: ${message}\n`));
}

const program = new Command();

program
  .name("shipcard")
  .description("Catch broken social cards before you ship. Supports Meta, LinkedIn, X, Pinterest, WhatsApp, Telegram, Bluesky, Mastodon, Slack, Discord, iMessage and more.")
  .version(VERSION)
  .argument("<target>", "URL or folder to audit (e.g. http://localhost:3000 or ./dist)")
  .option("--json", "output JSON only")
  .option("--fail-below <score>", "exit with code 1 if score is below this threshold (0-100)")
  .option("--timeout <ms>", "network timeout in milliseconds")
  .option("--no-images", "skip image validation")
  .option("--preview [file]", `write an HTML preview of every platform card (default: ${DEFAULT_PREVIEW_PATH})`)
  .option("--output <file>", "write the report (JSON or terminal text) to a file")
  .option("--watch", "watch target for changes and re-run (great for dev)")
  .option("--embed", "for --preview on folders: embed local images as data:base64 (portable HTML)")
  .action(async (target: string, opts: CliOptions) => {
    process.exit(await run(target, opts));
  });

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
