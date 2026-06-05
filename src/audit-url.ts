import { auditHtml } from "./audit-html.js";
import { summarize } from "./summarize.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport } from "./types.js";

export type AuditUrlOptions = AuditOptions & { version?: string };

/** Fetch a URL and audit the response body. */
export async function auditUrl(url: string, options: AuditUrlOptions): Promise<AuditReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let html: string;
  let finalUrl = url;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": `shipcard/${VERSION}`, accept: "text/html" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} when fetching ${url}`);
    finalUrl = response.url || url;
    html = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const page = await auditHtml(html, {
    source: finalUrl,
    path: finalUrl,
    sourceUrl: finalUrl,
    baseUrl: finalUrl,
    validateImages: options.validateImages,
    timeoutMs: options.timeoutMs,
  });

  return {
    tool: "shipcard",
    version: options.version ?? VERSION,
    createdAt: new Date().toISOString(),
    target: { type: "url", input: url },
    summary: summarize([page]),
    pages: [page],
  };
}
