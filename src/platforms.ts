import type {
  CardLayout,
  ImageAudit,
  Platform,
  PlatformField,
  PlatformImage,
  PlatformPreview,
  SocialMeta,
  Warning,
} from "./types.js";

/**
 * Per-platform rules for how each social network parses and renders link previews.
 *
 * These rules approximate documented platform behaviour. Real platforms tweak rendering
 * constantly — viewport, locale, A/B tests, and cache state all matter — so treat field
 * truncation and "rendersAsLarge" as best-effort indicators, not pixel-perfect promises.
 *
 * Sources are each platform's own developer docs (Open Graph protocol, X cards docs,
 * LinkedIn Post Inspector guidance, Slack unfurl docs).
 */

const PLATFORM_LABELS: Record<Platform, string> = {
  meta: "Meta (Facebook)",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  pinterest: "Pinterest",
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  imessage: "iMessage",
};

/** Build the platform preview for every supported platform. */
export function platformPreviews(
  meta: SocialMeta,
  image: ImageAudit | null,
): PlatformPreview[] {
  return [
    previewMeta(meta, image),
    previewLinkedIn(meta, image),
    previewX(meta, image),
    previewPinterest(meta, image),
    previewSlack(meta, image),
    previewDiscord(meta, image),
    previewWhatsApp(meta, image),
    previewTelegram(meta, image),
    previewBluesky(meta, image),
    previewMastodon(meta, image),
    previewIMessage(meta, image),
  ];
}

// -----------------------------------------------------------------------------
// Meta (Facebook) — OG only, no Twitter fallback. Large card needs 600x315+.
// -----------------------------------------------------------------------------

function previewMeta(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "<title>"], 88);
  const description = pickDescription(meta, ["og:description", "meta description"], 200);
  const img = pickImage(meta, image, ["og:image"], { minW: 200, minH: 200, largeW: 600, largeH: 315 });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (!img.url) warnings.push(missing("og:image", "warning"));
  if (img.url && !img.meetsMinimum) {
    warnings.push({
      severity: "warning",
      code: "meta-image-too-small",
      message: "Meta will fall back to a text-only card — image is below 200x200.",
    });
  } else if (img.url && !img.rendersAsLarge) {
    warnings.push({
      severity: "info",
      code: "meta-image-small-card",
      message: "Meta will render a small (thumbnail) card — image is below 600x315.",
    });
  }

  return {
    platform: "meta",
    label: PLATFORM_LABELS.meta,
    cardLayout: cardLayoutFor("meta", img),
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// LinkedIn — OG only, ignores twitter:* entirely. Recommends 1200x627 landscape.
// -----------------------------------------------------------------------------

function previewLinkedIn(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "<title>"], 70);
  const description = pickDescription(meta, ["og:description", "meta description"], 256);
  const img = pickImage(meta, image, ["og:image"], { minW: 200, minH: 200, largeW: 1200, largeH: 200 });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (!img.url) {
    warnings.push({
      severity: "warning",
      code: "linkedin-no-image",
      message: "LinkedIn will render a text-only card — og:image is missing.",
    });
  } else if (img.url && !img.rendersAsLarge) {
    warnings.push({
      severity: "warning",
      code: "linkedin-image-too-small",
      message: "LinkedIn recommends at least 1200x627 — smaller images may not render the large card.",
    });
  }
  // LinkedIn caches aggressively. Worth flagging once.
  warnings.push({
    severity: "info",
    code: "linkedin-cache",
    message: "LinkedIn caches previews for ~7 days. Use Post Inspector to refresh after deploying changes.",
  });

  return {
    platform: "linkedin",
    label: PLATFORM_LABELS.linkedin,
    cardLayout: cardLayoutFor("linkedin", img),
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// X (Twitter) — twitter:card drives layout; falls back to og:* for text/image.
// -----------------------------------------------------------------------------

function previewX(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["twitter:title", "og:title", "<title>"], 70);
  const description = pickDescription(
    meta,
    ["twitter:description", "og:description", "meta description"],
    200,
  );

  const declaredCard = meta.twitterCard?.toLowerCase();
  const wantsLarge = declaredCard === "summary_large_image";

  const minDims = wantsLarge ? { minW: 300, minH: 157 } : { minW: 144, minH: 144 };
  const img = pickImage(meta, image, ["twitter:image", "og:image"], {
    ...minDims,
    largeW: wantsLarge ? 300 : 9999, // "large" only meaningful when summary_large_image
    largeH: wantsLarge ? 157 : 9999,
  });

  const warnings: Warning[] = [];
  if (!declaredCard) {
    warnings.push({
      severity: "warning",
      code: "x-missing-card",
      message: 'X expects twitter:card. Set it to "summary_large_image" for the hero layout or "summary" for a thumbnail card.',
    });
  } else if (
    declaredCard !== "summary" &&
    declaredCard !== "summary_large_image" &&
    declaredCard !== "app" &&
    declaredCard !== "player"
  ) {
    warnings.push({
      severity: "warning",
      code: "x-unknown-card",
      message: `twitter:card="${declaredCard}" is not a recognised X card type.`,
    });
  }
  if (wantsLarge && img.url && !img.meetsMinimum) {
    warnings.push({
      severity: "warning",
      code: "x-image-too-small",
      message: "summary_large_image requires at least 300x157 — X will fall back to a smaller layout.",
    });
  }

  return {
    platform: "x",
    label: PLATFORM_LABELS.x,
    cardLayout: cardLayoutForX(declaredCard, img),
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Pinterest — OG heavy, loves tall/vertical images (2:3). 1000x1500 ideal for pins.
// -----------------------------------------------------------------------------
function previewPinterest(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "<title>"], 100);
  const description = pickDescription(meta, ["og:description", "meta description"], 300);
  const img = pickImage(meta, image, ["og:image"], {
    minW: 600,
    minH: 400,
    largeW: 1000,
    largeH: 1500,
  });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (!img.url) {
    warnings.push({
      severity: "warning",
      code: "pinterest-no-image",
      message: "Pinterest is visual-first — og:image is missing. Cards will be weak or text-only.",
    });
  } else if (img.url && !img.rendersAsLarge) {
    warnings.push({
      severity: "warning",
      code: "pinterest-image-not-vertical",
      message: "Pinterest strongly prefers tall 2:3 images (~1000x1500). Landscape or small images get less distribution.",
    });
  }

  return {
    platform: "pinterest",
    label: PLATFORM_LABELS.pinterest,
    cardLayout: img.url ? (img.rendersAsLarge ? "large" : "summary") : "none",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// WhatsApp — OG only. Stricter file size (<600KB). 1200x630 works well.
// -----------------------------------------------------------------------------
function previewWhatsApp(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "<title>"], 60);
  const description = pickDescription(meta, ["og:description", "meta description"], 120);
  const img = pickImage(meta, image, ["og:image"], {
    minW: 300,
    minH: 200,
    largeW: 1200,
    largeH: 630,
  });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (img.url) {
    // Note: actual size check happens in validateImage (5MB), we surface WhatsApp-specific here if we have bytes.
    // We keep it informational; the hard 5MB is already warned.
    if (image && image.sizeBytes && image.sizeBytes > 600 * 1024) {
      warnings.push({
        severity: "warning",
        code: "whatsapp-image-too-large",
        message: "WhatsApp prefers og:image under 600 KB. Larger images may fail to preview or load slowly.",
      });
    }
  }

  return {
    platform: "whatsapp",
    label: PLATFORM_LABELS.whatsapp,
    cardLayout: img.url ? "large" : title.value ? "inline" : "none",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Telegram — OG + respects twitter:card=summary_large_image for big previews.
// -----------------------------------------------------------------------------
function previewTelegram(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "twitter:title", "<title>"], 80);
  const description = pickDescription(
    meta,
    ["og:description", "twitter:description", "meta description"],
    200,
  );
  const img = pickImage(meta, image, ["og:image", "twitter:image"], {
    minW: 300,
    minH: 200,
    largeW: 1200,
    largeH: 630,
  });

  const wantsLarge = meta.twitterCard?.toLowerCase() === "summary_large_image";

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));

  return {
    platform: "telegram",
    label: PLATFORM_LABELS.telegram,
    cardLayout: img.url ? (wantsLarge && img.rendersAsLarge ? "large" : "summary") : "inline",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Bluesky — primarily OG (with some twitter fallbacks). 1200x630 or square both fine.
// -----------------------------------------------------------------------------
function previewBluesky(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "twitter:title", "<title>"], 80);
  const description = pickDescription(
    meta,
    ["og:description", "twitter:description", "meta description"],
    200,
  );
  const img = pickImage(meta, image, ["og:image", "twitter:image"], {
    minW: 400,
    minH: 400,
    largeW: 1200,
    largeH: 630,
  });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));

  return {
    platform: "bluesky",
    label: PLATFORM_LABELS.bluesky,
    cardLayout: img.url ? (img.rendersAsLarge ? "large" : "summary") : title.value ? "inline" : "none",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Mastodon — OG + twitter, flexible images. Instance caching applies.
// -----------------------------------------------------------------------------
function previewMastodon(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "twitter:title", "<title>"], 80);
  const description = pickDescription(
    meta,
    ["og:description", "twitter:description", "meta description"],
    200,
  );
  const img = pickImage(meta, image, ["og:image", "twitter:image"], {
    minW: 300,
    minH: 200,
    largeW: 1200,
    largeH: 630,
  });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  warnings.push({
    severity: "info",
    code: "mastodon-cache",
    message: "Mastodon instances cache link previews. Use your instance's 'preview card' refresh or post again after changes.",
  });

  return {
    platform: "mastodon",
    label: PLATFORM_LABELS.mastodon,
    cardLayout: img.url ? (img.rendersAsLarge ? "large" : "summary") : "inline",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Slack — inline rich unfurl. OG-first, twitter:* fallback.
// -----------------------------------------------------------------------------

function previewSlack(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "twitter:title", "<title>"], 80);
  const description = pickDescription(
    meta,
    ["og:description", "twitter:description", "meta description"],
    200,
  );
  const img = pickImage(meta, image, ["og:image", "twitter:image"], {
    minW: 1,
    minH: 1,
    largeW: 1,
    largeH: 1,
  });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (!description.value) warnings.push(missing("og:description", "info"));

  return {
    platform: "slack",
    label: PLATFORM_LABELS.slack,
    cardLayout: img.url ? "inline" : title.value || description.value ? "inline" : "none",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Discord — embeds OG. twitter:card="summary_large_image" upgrades to large embed.
// -----------------------------------------------------------------------------

function previewDiscord(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "twitter:title", "<title>"], 256);
  const description = pickDescription(
    meta,
    ["og:description", "twitter:description", "meta description"],
    350,
  );
  const img = pickImage(meta, image, ["og:image", "twitter:image"], {
    minW: 1,
    minH: 1,
    largeW: 1,
    largeH: 1,
  });

  const wantsLarge = meta.twitterCard?.toLowerCase() === "summary_large_image";

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (img.url && !wantsLarge) {
    warnings.push({
      severity: "info",
      code: "discord-small-embed",
      message: 'Discord renders a small thumbnail by default. Set twitter:card="summary_large_image" for a hero image embed.',
    });
  }

  return {
    platform: "discord",
    label: PLATFORM_LABELS.discord,
    cardLayout: img.url ? (wantsLarge ? "large" : "inline") : title.value ? "inline" : "none",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// iMessage (Apple) — minimal: title + image + domain. Square-crops the image.
// -----------------------------------------------------------------------------

function previewIMessage(meta: SocialMeta, image: ImageAudit | null): PlatformPreview {
  const title = pickTitle(meta, ["og:title", "<title>"], 60);
  const description: PlatformField = {
    value: null,
    source: null,
    truncated: false,
    charLimit: null,
  };
  const img = pickImage(meta, image, ["og:image"], { minW: 144, minH: 144, largeW: 800, largeH: 800 });

  const warnings: Warning[] = [];
  if (!title.value) warnings.push(missing("og:title", "warning"));
  if (img.url && !img.meetsMinimum) {
    warnings.push({
      severity: "info",
      code: "imessage-image-small",
      message: "iMessage prefers images of at least 144x144 — smaller images may not render.",
    });
  }

  return {
    platform: "imessage",
    label: PLATFORM_LABELS.imessage,
    cardLayout: img.url ? "summary" : title.value ? "inline" : "none",
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Helpers — title/description/image selection with documented fallback chains.
// -----------------------------------------------------------------------------

type TitleSource = "og:title" | "twitter:title" | "<title>";
type DescriptionSource = "og:description" | "twitter:description" | "meta description";
type ImageSource = "og:image" | "twitter:image";

function pickTitle(meta: SocialMeta, chain: TitleSource[], limit: number): PlatformField {
  for (const source of chain) {
    const value = readTitle(meta, source);
    if (value) return truncate(value, source, limit);
  }
  return { value: null, source: null, truncated: false, charLimit: limit };
}

function pickDescription(
  meta: SocialMeta,
  chain: DescriptionSource[],
  limit: number,
): PlatformField {
  for (const source of chain) {
    const value = readDescription(meta, source);
    if (value) return truncate(value, source, limit);
  }
  return { value: null, source: null, truncated: false, charLimit: limit };
}

function readTitle(meta: SocialMeta, source: TitleSource): string | null {
  if (source === "og:title") return meta.raw.openGraph["title"]?.[0] ?? null;
  if (source === "twitter:title") return meta.raw.twitter["title"]?.[0] ?? null;
  return meta.raw.titleTag;
}

function readDescription(meta: SocialMeta, source: DescriptionSource): string | null {
  if (source === "og:description") return meta.raw.openGraph["description"]?.[0] ?? null;
  if (source === "twitter:description") return meta.raw.twitter["description"]?.[0] ?? null;
  return meta.raw.metaDescription;
}

function truncate(value: string, source: string, limit: number): PlatformField {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return { value: trimmed, source, truncated: false, charLimit: limit };
  }
  return {
    value: trimmed.slice(0, Math.max(0, limit - 1)) + "…",
    source,
    truncated: true,
    charLimit: limit,
  };
}

type ImageDims = { minW: number; minH: number; largeW: number; largeH: number };

function pickImage(
  meta: SocialMeta,
  image: ImageAudit | null,
  chain: ImageSource[],
  dims: ImageDims,
): PlatformImage {
  let chosenSource: ImageSource | null = null;
  let url: string | null = null;
  for (const source of chain) {
    const v =
      source === "og:image"
        ? meta.raw.openGraph["image"]?.[0]
        : meta.raw.twitter["image"]?.[0];
    if (v) {
      chosenSource = source;
      url = v;
      break;
    }
  }

  // Use probe data when available — most sites use the same image for og:image
  // and twitter:image, so the probe is a reliable approximation even when the
  // platform's chosen source URL differs from what was probed.
  const haveProbe =
    image !== null && image.found && image.width !== null && image.height !== null;

  const meetsMinimum = haveProbe ? image!.width! >= dims.minW && image!.height! >= dims.minH : !!url;
  const rendersAsLarge = haveProbe
    ? image!.width! >= dims.largeW && image!.height! >= dims.largeH
    : false;

  return { url, source: chosenSource, meetsMinimum, rendersAsLarge };
}

function cardLayoutFor(platform: "meta" | "linkedin", image: PlatformImage): CardLayout {
  if (!image.url) return platform === "linkedin" ? "summary" : "none";
  if (image.rendersAsLarge) return "large";
  return image.meetsMinimum ? "summary" : "none";
}

function cardLayoutForX(declaredCard: string | undefined, image: PlatformImage): CardLayout {
  if (!image.url) return "none";
  if (declaredCard === "summary_large_image" && image.meetsMinimum) return "large";
  return "summary";
}

function missing(name: string, severity: Warning["severity"]): Warning {
  return {
    severity,
    code: `platform-missing-${name.replace(/:/g, "-")}`,
    message: `${name} is missing.`,
  };
}
