import { Parser } from "htmlparser2";
import type { SocialMeta } from "./types.js";
import { firstNonEmpty } from "./utils.js";

/**
 * Parse social and SEO metadata from an HTML document.
 * Scans the full document so misnested tags outside <head> are still found,
 * while ignoring <title> elements nested inside <svg>.
 */
export function extractMeta(html: string): SocialMeta {
  const openGraph: Record<string, string[]> = {};
  const twitter: Record<string, string[]> = {};
  const links: Record<string, string[]> = {};
  let metaDescription: string | null = null;

  let svgDepth = 0;
  let inTitle = false;
  let titleDone = false;
  const titleParts: string[] = [];

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
        const key = (attribs.property || attribs.name || "").trim().toLowerCase();
        const content = attribs.content;
        if (!key || typeof content !== "string") return;
        const value = content.trim();
        if (!value) return;

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

  return {
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
  };
}
