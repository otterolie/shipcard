import * as cheerio from "cheerio";
import type { SocialMeta } from "./types.js";
import { firstNonEmpty } from "./utils.js";

/**
 * Parse social/SEO metadata from an HTML document's <head>.
 *
 * OG and Twitter tags are accepted on either the `property` or `name` attribute —
 * the OGP spec uses `property` and the Twitter spec uses `name`, but real-world
 * sites mix them freely and major crawlers accept both.
 */
export function extractMeta(html: string): SocialMeta {
  const $ = cheerio.load(html);

  const openGraph: Record<string, string[]> = {};
  const twitter: Record<string, string[]> = {};
  const links: Record<string, string[]> = {};

  $("head meta").each((_, el) => {
    const $el = $(el);
    const key = ($el.attr("property") || $el.attr("name") || "").trim().toLowerCase();
    const content = $el.attr("content");
    if (!key || typeof content !== "string") return;
    const value = content.trim();
    if (!value) return;

    if (key.startsWith("og:")) {
      (openGraph[key.slice(3)] ||= []).push(value);
    } else if (key.startsWith("twitter:")) {
      (twitter[key.slice("twitter:".length)] ||= []).push(value);
    }
  });

  $("head link").each((_, el) => {
    const $el = $(el);
    const rel = ($el.attr("rel") || "").trim().toLowerCase();
    const href = $el.attr("href")?.trim();
    if (!rel || !href) return;
    (links[rel] ||= []).push(href);
  });

  const titleTag = $("head > title").first().text().trim() || null;
  const metaDescription =
    $('head meta[name="description"]').first().attr("content")?.trim() || null;

  return {
    title: firstNonEmpty(openGraph["title"]?.[0], titleTag),
    description: firstNonEmpty(openGraph["description"]?.[0], metaDescription),
    image: firstNonEmpty(openGraph["image"]?.[0], twitter["image"]?.[0]),
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
