import { Parser } from "htmlparser2";
import { auditHtml } from "./audit-html.js";
import { failedPage } from "./audit-folder.js";
import { extractMetaWithStats } from "./extract-meta.js";
import { buildReport } from "./report.js";
import { createImageCache } from "./validate-image.js";
import { isHttpUrl, isIgnoredPath, mapWithConcurrency } from "./utils.js";
import { VERSION } from "./version.js";
import type { AuditOptions, AuditReport, PageReport, SkippedPage } from "./types.js";

const DEFAULT_MAX_PAGES = 50;
const SITEMAP_CONCURRENCY = 5;

export type AuditSitemapOptions = AuditOptions & {
  fetchImpl?: typeof fetch;
};

/** Parse <loc> entries from an XML <urlset> or <sitemapindex> document. */
export function parseSitemapXml(xml: string): { urls: string[]; sitemaps: string[] } {
  const urls: string[] = [];
  const sitemaps: string[] = [];

  let container: "url" | "sitemap" | null = null;
  let inLoc = false;
  let buf: string[] = [];

  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase().replace(/^.*:/, "");
        if (tag === "url") container = "url";
        else if (tag === "sitemap") container = "sitemap";
        else if (tag === "loc" && container) {
          inLoc = true;
          buf = [];
        }
      },
      ontext(text) {
        if (inLoc) buf.push(text);
      },
      onclosetag(name) {
        const tag = name.toLowerCase().replace(/^.*:/, "");
        if (tag === "loc" && inLoc) {
          const loc = buf.join("").trim();
          if (loc && isHttpUrl(loc)) {
            if (container === "sitemap") sitemaps.push(loc);
            else if (container === "url") urls.push(loc);
          }
          inLoc = false;
        } else if (tag === "url" || tag === "sitemap") {
          container = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  parser.write(xml);
  parser.end();

  return { urls, sitemaps };
}

/** Fetch an XML sitemap (or sitemap index) and audit each listed page URL. */
export async function auditSitemap(
  sitemapUrl: string,
  options: AuditSitemapOptions = {},
): Promise<AuditReport> {
  const version = options.version ?? VERSION;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const fetchImpl = options.fetchImpl ?? fetch;

  const xml = await fetchText(sitemapUrl, {
    fetchImpl,
    timeoutMs: options.timeoutMs ?? 15_000,
    version,
    accept: "application/xml, text/xml, */*",
  });

  const parsed = parseSitemapXml(xml);
  const rawUrls: string[] = [...parsed.urls];

  // Follow child sitemaps one level deep if this is a sitemap index.
  if (rawUrls.length === 0 && parsed.sitemaps.length > 0) {
    for (const childUrl of parsed.sitemaps) {
      if (rawUrls.length >= maxPages) break;
      try {
        const childXml = await fetchText(childUrl, {
          fetchImpl,
          timeoutMs: options.timeoutMs ?? 15_000,
          version,
          accept: "application/xml, text/xml, */*",
        });
        rawUrls.push(...parseSitemapXml(childXml).urls);
      } catch {
        // skip unreachable child sitemap
      }
    }
  }

  const seen = new Set<string>();
  const targets: string[] = [];
  const skipped: SkippedPage[] = [];

  for (const url of rawUrls) {
    if (seen.has(url)) continue;
    seen.add(url);

    const pathname = safePathname(url);
    if (pathname && isIgnoredPath(pathname, options.ignore)) {
      skipped.push({ path: url, reason: "ignored" });
      continue;
    }

    if (targets.length >= maxPages) break;
    targets.push(url);
  }

  if (targets.length === 0 && skipped.length === 0) {
    throw new Error(`No URLs found in sitemap: ${sitemapUrl}`);
  }

  const imageCache = createImageCache();
  const outcomes = await mapWithConcurrency<
    string,
    { page: PageReport } | { skipped: SkippedPage }
  >(targets, SITEMAP_CONCURRENCY, async (url) => {
    try {
      const { html, finalUrl } = await fetchHtml(url, {
        fetchImpl,
        timeoutMs: options.timeoutMs ?? 15_000,
        version,
      });
      if (!options.includeRedirects && extractMetaWithStats(html).isRedirect) {
        return { skipped: { path: finalUrl, reason: "redirect" as const } };
      }
      const page = await auditHtml(html, {
        source: finalUrl,
        path: finalUrl,
        sourceUrl: finalUrl,
        baseUrl: finalUrl,
        validateImages: options.validateImages,
        timeoutMs: options.timeoutMs,
        offline: options.offline,
        imageCache,
        fetchImpl,
      });
      return { page };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { page: failedPage(url, url, message) };
    }
  });

  const pages: PageReport[] = [];
  for (const outcome of outcomes) {
    if ("skipped" in outcome) {
      skipped.push(outcome.skipped);
    } else {
      pages.push(outcome.page);
    }
  }

  return buildReport(pages, {
    version,
    type: "sitemap",
    input: sitemapUrl,
    skipped,
  });
}

async function fetchText(
  url: string,
  opts: { fetchImpl: typeof fetch; timeoutMs: number; version: string; accept: string },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await opts.fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": `shipcard/${opts.version}`, accept: opts.accept },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} when fetching ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(
  url: string,
  opts: { fetchImpl: typeof fetch; timeoutMs: number; version: string },
): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await opts.fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": `shipcard/${opts.version}`, accept: "text/html" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function safePathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
