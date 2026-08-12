#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { audit } from "./index.js";
import { planFromReport } from "./plan.js";
import { NoHtmlFilesError } from "./audit-folder.js";
import { renderTerminal } from "./render-terminal.js";
import { renderPreviewHtml } from "./preview-html.js";
import { VERSION } from "./version.js";
import type { AuditReport } from "./types.js";

const DEFAULT_PREVIEW_PATH = "shipcard-preview.html";

type CliOptions = {
  json: boolean;
  failBelow?: string;
  timeout?: string;
  images: boolean;
  offline: boolean;
  preview?: string;
  output?: string;
  watch: boolean;
  embed: boolean;
};

const HELP = `shipcard ${VERSION}

Catch broken social cards before you ship.

Usage:
  shipcard <target> [options]

  target  URL, folder, .html file, or - for stdin

Options:
  --json                 print JSON (includes plan.actions for agents)
  --fail-below <n>       exit 1 if score < n (0-100)
  --timeout <ms>         network timeout
  --no-images            skip image validation entirely
  --offline              don't fetch remote images (local files / path maps only)
  --preview [file]       write HTML card mockups (default: ${DEFAULT_PREVIEW_PATH})
  --embed                with --preview, inline local images as data: URIs
  --output <file>        write the report to a file
  --watch                re-run when the target changes
  -h, --help             show help
  -V, --version          show version

Pre-launch tip:
  Absolute og:image URLs to a site that isn't deployed yet will 404 on live fetch.
  Prefer:  shipcard ./dist --offline
  Or skip images:  shipcard ./dist --no-images --fail-below 80
`;

function parseCli(argv: string[]): { target: string; opts: CliOptions } | "help" | "version" {
  // parseArgs requires a value for string options; bare --preview → default path
  const normalized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preview") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        normalized.push("--preview", DEFAULT_PREVIEW_PATH);
      } else {
        normalized.push("--preview", next);
        i++;
      }
      continue;
    }
    normalized.push(arg);
  }

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: normalized,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        "fail-below": { type: "string" },
        timeout: { type: "string" },
        "no-images": { type: "boolean", default: false },
        offline: { type: "boolean", default: false },
        preview: { type: "string" },
        output: { type: "string" },
        watch: { type: "boolean", default: false },
        embed: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  if (values.help) return "help";
  if (values.version) return "version";

  const target = positionals[0];
  if (!target) {
    throw new Error("Missing target. Pass a URL, folder, .html file, or - for stdin.");
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected arguments: ${positionals.slice(1).join(" ")}`);
  }

  return {
    target,
    opts: {
      json: !!values.json,
      failBelow: values["fail-below"] as string | undefined,
      timeout: values.timeout as string | undefined,
      images: !values["no-images"],
      offline: !!values.offline,
      preview: values.preview as string | undefined,
      output: values.output as string | undefined,
      watch: !!values.watch,
      embed: !!values.embed,
    },
  };
}

async function runOnce(target: string, opts: CliOptions): Promise<{ code: number; report?: AuditReport }> {
  const failBelow = parseFailBelow(opts.failBelow);
  if (failBelow instanceof Error) {
    emitError(opts, "bad-flag", failBelow.message);
    return { code: 1 };
  }

  let report: AuditReport;
  try {
    report = await audit(target, {
      version: VERSION,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
      validateImages: opts.images,
      offline: opts.offline,
    });
  } catch (err) {
    if (err instanceof NoHtmlFilesError) {
      emitError(
        opts,
        "no-html-files",
        err.message,
        "Point shipcard at a built site folder. Common targets: ./dist, ./out, ./build, ./public.",
      );
      return { code: 1 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.startsWith("Target not found") ? "target-not-found" : "audit-failed";
    const hint =
      code === "target-not-found"
        ? "Pass a URL, a folder (./dist), a .html file, or - for stdin."
        : undefined;
    emitError(opts, code, msg, hint);
    return { code: 1 };
  }

  // Always attach plan for machine consumers; agents use plan.actions as the todo list.
  const plan = planFromReport(report);
  const reportWithPlan: AuditReport = { ...report, plan };

  if (opts.json) {
    process.stdout.write(JSON.stringify(reportWithPlan, null, 2) + "\n");
  } else {
    process.stdout.write(renderTerminal(reportWithPlan));
  }

  if (opts.output) {
    try {
      const content = opts.json
        ? JSON.stringify(reportWithPlan, null, 2) + "\n"
        : renderTerminal(reportWithPlan);
      await fsp.writeFile(path.resolve(opts.output), content, "utf8");
      if (!opts.json) process.stdout.write(pc.dim(`\nReport written to ${opts.output}\n`));
    } catch (err) {
      emitError(
        opts,
        "write-failed",
        `Could not write --output: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { code: 1 };
    }
  }

  if (opts.preview) {
    try {
      await fsp.writeFile(
        path.resolve(opts.preview),
        renderPreviewHtml(reportWithPlan, { embedLocalImages: opts.embed }),
        "utf8",
      );
      if (!opts.json) process.stdout.write(pc.dim(`\nPreview written to ${opts.preview}\n`));
    } catch (err) {
      emitError(
        opts,
        "write-failed",
        `Could not write preview: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { code: 1 };
    }
  }

  if (failBelow !== null && reportWithPlan.summary.score < failBelow) {
    if (!opts.json) {
      process.stdout.write(
        pc.red(
          `\nShip blocked: score ${reportWithPlan.summary.score} is below threshold ${failBelow}.\n`,
        ),
      );
    }
    return { code: 1, report: reportWithPlan };
  }

  return { code: 0, report: reportWithPlan };
}

async function run(target: string, opts: CliOptions): Promise<number> {
  const result = await runOnce(target, opts);
  if (!opts.watch) return result.code;

  const toWatch = target === "-" ? process.cwd() : target;
  process.stderr.write(pc.dim(`[watch] Watching ${toWatch} for changes (Ctrl-C to stop)\n`));

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;

  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      process.stderr.write(pc.dim(`[watch] change — re-running audit...\n`));
      try {
        await runOnce(target, opts);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          kick();
        }
      }
    }, 200);
  };

  const onChange = (_event: string, filename: string | null) => {
    if (filename && String(filename).includes("node_modules")) return;
    kick();
  };

  try {
    // recursive is solid on macOS/Windows; Linux support varies by Node version
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(toWatch, { recursive: true }, onChange);
    } catch {
      watcher = fs.watch(toWatch, onChange);
      process.stderr.write(pc.dim("[watch] recursive unavailable — watching top level only\n"));
    }
    watcher.on("error", (err) => {
      process.stderr.write(pc.red(`[watch] ${err.message}\n`));
    });
  } catch (err) {
    process.stderr.write(
      pc.red(`shipcard: could not watch ${toWatch}: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    return 1;
  }

  await new Promise(() => {});
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

function emitError(opts: CliOptions, code: string, message: string, hint?: string): void {
  if (opts.json) {
    const body: Record<string, unknown> = {
      tool: "shipcard",
      version: VERSION,
      error: hint ? { code, message, hint } : { code, message },
    };
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  process.stderr.write(pc.red(`shipcard: ${message}\n`));
  if (hint) process.stderr.write(pc.dim(`hint: ${hint}\n`));
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(pc.red(`shipcard: ${err instanceof Error ? err.message : String(err)}\n`));
    process.stderr.write(pc.dim("Try shipcard --help\n"));
    process.exit(1);
  }

  if (parsed === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed === "version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }

  process.exit(await run(parsed.target, parsed.opts));
}

main().catch((err) => {
  process.stderr.write(pc.red(`shipcard: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});
