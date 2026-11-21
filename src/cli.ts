#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import {
  audit,
  NoHtmlFilesError,
  renderPreviewHtml,
  renderTerminal,
  version as VERSION,
  type AuditReport,
} from "./index.js";

const DEFAULT_PREVIEW_PATH = "shipcard-preview.html";
const VALUE_FLAGS = new Set(["--fail-below", "--timeout", "--output"]);

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

Check Open Graph, Twitter, and social link preview tags before you ship.

Usage:
  shipcard <target> [options]

  target  URL, build folder, .html file, or - for stdin

Options:
  --json                 print JSON report
  --fail-below <n>       exit 1 if score < n (0-100)
  --timeout <ms>         network timeout in milliseconds
  --no-images            skip image validation
  --offline              check local files only; never fetch remote images
  --preview [file]       write HTML card previews (default: ${DEFAULT_PREVIEW_PATH})
  --embed                with --preview, inline local images as data URIs
  --output <file>        write the report to a file
  --watch                re-run when local target files change
  -h, --help             show help
  -V, --version          show version

Examples:
  shipcard ./dist --offline
  shipcard http://localhost:3000
  shipcard ./dist --preview cards.html --embed
`;

function normalizePreviewArg(argv: string[]): string[] {
  // Determine whether a positional target already exists outside --preview so
  // `shipcard --preview ./dist` keeps `./dist` as the target instead of the preview path.
  const positionalsOutsidePreview: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) positionalsOutsidePreview.push(j);
      break;
    }
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--preview" || arg.startsWith("--preview=")) continue;
    if (arg === "-" || !arg.startsWith("-")) positionalsOutsidePreview.push(i);
  }

  const normalized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preview") {
      const next = argv[i + 1];
      const nextIsFlag = !next || (next.startsWith("-") && next !== "-");
      const otherPositionals = positionalsOutsidePreview.filter((idx) => idx !== i + 1);
      if (nextIsFlag || next === "-" || otherPositionals.length === 0) {
        normalized.push("--preview", DEFAULT_PREVIEW_PATH);
      } else {
        normalized.push("--preview", next);
        i++;
      }
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function parseCli(argv: string[]): { target: string; opts: CliOptions } | "help" | "version" {
  const normalized = normalizePreviewArg(argv);

  const { values, positionals } = parseArgs({
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
    emitError(opts.json, "bad-flag", failBelow.message);
    return { code: 1 };
  }

  const timeoutMs = parseTimeout(opts.timeout);
  if (timeoutMs instanceof Error) {
    emitError(opts.json, "bad-flag", timeoutMs.message);
    return { code: 1 };
  }

  let report: AuditReport;
  try {
    report = await audit(target, {
      version: VERSION,
      timeoutMs: timeoutMs ?? undefined,
      validateImages: opts.images,
      offline: opts.offline,
    });
  } catch (err) {
    if (err instanceof NoHtmlFilesError) {
      emitError(
        opts.json,
        "no-html-files",
        err.message,
        "Pass a built site folder such as ./dist, ./out, ./build, or ./public.",
      );
      return { code: 1 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.startsWith("Target not found") ? "target-not-found" : "audit-failed";
    const hint =
      code === "target-not-found"
        ? "Pass a URL, a folder (./dist), a .html file, or - for stdin."
        : undefined;
    emitError(opts.json, code, msg, hint);
    return { code: 1 };
  }

  const jsonOutput = opts.json ? JSON.stringify(report, null, 2) + "\n" : null;
  process.stdout.write(jsonOutput ?? renderTerminal(report));

  if (opts.output) {
    try {
      const content = jsonOutput ?? renderTerminal(report, { color: false });
      await fsp.writeFile(path.resolve(opts.output), content, "utf8");
      if (!opts.json) process.stdout.write(pc.dim(`\nReport written to ${opts.output}\n`));
    } catch (err) {
      emitError(
        opts.json,
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
        renderPreviewHtml(report, { embedLocalImages: opts.embed }),
        "utf8",
      );
      if (!opts.json) process.stdout.write(pc.dim(`\nPreview written to ${opts.preview}\n`));
    } catch (err) {
      emitError(
        opts.json,
        "write-failed",
        `Could not write preview: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { code: 1 };
    }
  }

  if (failBelow !== null && report.summary.score < failBelow) {
    if (!opts.json) {
      process.stdout.write(
        pc.red(`\nFailed: score ${report.summary.score} is below --fail-below ${failBelow}.\n`),
      );
    }
    return { code: 1, report };
  }

  return { code: 0, report };
}

async function run(target: string, opts: CliOptions): Promise<number> {
  if (opts.watch && (target === "-" || /^https?:\/\//i.test(target))) {
    emitError(opts.json, "bad-flag", "--watch only supports local folders or .html files.");
    return 1;
  }

  const result = await runOnce(target, opts);
  if (!opts.watch) return result.code;

  const watchRoot = path.resolve(target);
  const ignoredOutputs = new Set(
    [opts.preview, opts.output].filter((p): p is string => !!p).map((p) => path.resolve(p)),
  );

  process.stderr.write(pc.dim(`[watch] Watching ${target} (Ctrl-C to stop)\n`));

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
      process.stderr.write(pc.dim("[watch] Re-running audit...\n"));
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
    if (filename) {
      const text = String(filename);
      if (text.includes("node_modules")) return;
      const changedAbs = path.resolve(watchRoot, text);
      if (ignoredOutputs.has(changedAbs)) return;
    }
    kick();
  };

  let watcher: fs.FSWatcher;
  try {
    try {
      watcher = fs.watch(watchRoot, { recursive: true }, onChange);
    } catch {
      watcher = fs.watch(watchRoot, onChange);
      process.stderr.write(pc.dim("[watch] Recursive watch unavailable; watching top level only\n"));
    }
    watcher.on("error", (err) => {
      process.stderr.write(pc.red(`[watch] ${err.message}\n`));
    });
  } catch (err) {
    emitError(
      opts.json,
      "watch-failed",
      `Could not watch ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      if (timer) clearTimeout(timer);
      watcher.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

function parseFailBelow(value: string | undefined): number | null | Error {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return new Error(`--fail-below must be a number between 0 and 100, got "${value}".`);
  }
  return n;
}

function parseTimeout(value: string | undefined): number | null | Error {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return new Error(`--timeout must be a positive number in ms, got "${value}".`);
  }
  return n;
}

function emitError(json: boolean, code: string, message: string, hint?: string): void {
  if (json) {
    const body = {
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
  const rawArgs = process.argv.slice(2);
  const wantsJson = rawArgs.includes("--json");

  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(rawArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitError(wantsJson, "bad-args", msg, "Run shipcard --help for usage.");
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
  const wantsJson = process.argv.includes("--json");
  emitError(wantsJson, "unexpected", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
