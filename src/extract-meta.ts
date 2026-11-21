import { Parser } from "htmlparser2";
import type { SocialMeta } from "./types.js";
import { firstNonEmpty } from "./utils.js";

const CORE_SOCIAL_KEYS = new Set([
  "og:title",
  "og:description",
  "og:image",
  "og:image:url",
  "twitter:card",
  "twitter:image",
]);

export type MetaExtraction = {
  meta: SocialMeta;
  /** UTF-8 byte offset where the last core social meta tag ends (0 if none). */
  lastSocialTagByte: number;
  /** True when the document contains a <meta http-equiv="refresh" content="...url=..."> redirect. */
  isRedirect: boolean;
};

/**
 * Parse social and SEO metadata from an HTML document.
 * Scans the full document so misnested tags outside <head> are still found,
 * while ignoring <title> elements nested inside <svg>.
 */
export function extractMeta(html: string): SocialMeta {
  return extractMetaWithStats(html).meta;
}

/** Parse metadata along with crawler-relevant document stats (tag byte offset, redirect stub). */
export function extractMetaWithStats(html: string): MetaExtraction {
  const openGraph: Record<string, string[]> = {};
  const twitter: Record<string, string[]> = {};
  const links: Record<string, string[]> = {};
  let metaDescription: string | null = null;

  let svgDepth = 0;
  let inTitle = false;
  let titleDone = false;
  const titleParts: string[] = [];
  let lastSocialTagCharEnd = -1;
  let isRedirect = false;

  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "svg") {
        svgDepth++;
        return;
      }

      if (name === "title" && svgDepth === 0 && !titleDone) {
        inTitle = true;
        return;
      }

      if (name === "meta") {
        const httpEquiv = (attribs["http-equiv"] || "").trim().toLowerCase();
        if (httpEquiv === "refresh" && typeof attribs.content === "string") {
          if (/\burl\s*=/i.test(attribs.content)) isRedirect = true;
        }

        const key = (attribs.property || attribs.name || "").trim().toLowerCase();
        const content = attribs.content;
        if (!key || typeof content !== "string") return;
        const value = content.trim();
        if (!value) return;

        if (CORE_SOCIAL_KEYS.has(key) && parser.endIndex > lastSocialTagCharEnd) {
          lastSocialTagCharEnd = parser.endIndex;
        }

        if (key === "description" && metaDescription === null) {
          metaDescription = value;
        } else if (key.startsWith("og:")) {
          (openGraph[key.slice(3)] ||= []).push(value);
        } else if (key.startsWith("twitter:")) {
          (twitter[key.slice("twitter:".length)] ||= []).push(value);
        }
        return;
      }

      if (name === "link") {
        const relAttr = (attribs.rel || "").trim().toLowerCase();
        const href = attribs.href?.trim();
        if (!relAttr || !href) return;
        for (const rel of relAttr.split(/\s+/)) {
          if (rel) (links[rel] ||= []).push(href);
        }
      }
    },
    ontext(text) {
      if (inTitle) titleParts.push(text);
    },
    onclosetag(name) {
      if (name === "svg" && svgDepth > 0) {
        svgDepth--;
      } else if (name === "title" && inTitle) {
        inTitle = false;
        titleDone = true;
      }
    },
  });

  parser.write(html);
  parser.end();

  const titleTag = titleParts.join("").trim() || null;
  const lastSocialTagByte =
    lastSocialTagCharEnd >= 0
      ? Buffer.byteLength(html.slice(0, lastSocialTagCharEnd + 1), "utf8")
      : 0;

  return {
    meta: {
      title: firstNonEmpty(openGraph["title"]?.[0], titleTag),
      description: firstNonEmpty(openGraph["description"]?.[0], metaDescription),
      image: firstNonEmpty(openGraph["image"]?.[0], openGraph["image:url"]?.[0], twitter["image"]?.[0]),
      url: openGraph["url"]?.[0] ?? null,
      type: openGraph["type"]?.[0] ?? null,
      siteName: openGraph["site_name"]?.[0] ?? null,
      canonical: links["canonical"]?.[0] ?? null,
      twitterCard: twitter["card"]?.[0] ?? null,
      twitterTitle: twitter["title"]?.[0] ?? null,
      twitterDescription: twitter["description"]?.[0] ?? null,
      twitterImage: twitter["image"]?.[0] ?? null,
      raw: { titleTag, metaDescription, openGraph, twitter, links },
    },
    lastSocialTagByte,
    isRedirect,
  };
}
