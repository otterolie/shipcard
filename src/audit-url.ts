import { auditHtml } from "./audit-html.js";
import { buildReport } from "./report.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport } from "./types.js";

/** Fetch a URL and audit the response body. */
export async function auditUrl(url: string, options: AuditOptions = {}): Promise<AuditReport> {
  const version = options.version ?? VERSION;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let html: string;
  let finalUrl = url;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": `shipcard/${version}`, accept: "text/html" },
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
    offline: options.offline,
  });

  return buildReport([page], { version, type: "url", input: url });
}
