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

type TitleSource = "og:title" | "twitter:title" | "<title>";
type DescriptionSource = "og:description" | "twitter:description" | "meta description";
type ImageSource = "og:image" | "twitter:image";
type ImageDims = { minW: number; minH: number; largeW: number; largeH: number };

type PreviewCtx = {
  meta: SocialMeta;
  image: ImageAudit | null;
  title: PlatformField;
  description: PlatformField;
  img: PlatformImage;
};

type PlatformRule = {
  platform: Platform;
  label: string;
  titleChain: TitleSource[];
  titleLimit: number;
  descChain: DescriptionSource[] | null;
  descLimit?: number;
  imageChain: ImageSource[];
  dims: ImageDims;
  layout: (ctx: PreviewCtx) => CardLayout;
  extraWarnings?: (ctx: PreviewCtx) => Warning[];
};

const OG_TITLE: TitleSource[] = ["og:title", "<title>"];
const OG_TW_TITLE: TitleSource[] = ["og:title", "twitter:title", "<title>"];
const OG_DESC: DescriptionSource[] = ["og:description", "meta description"];
const OG_TW_DESC: DescriptionSource[] = ["og:description", "twitter:description", "meta description"];
const OG_IMG: ImageSource[] = ["og:image"];
const OG_TW_IMG: ImageSource[] = ["og:image", "twitter:image"];

const RULES: PlatformRule[] = [
  {
    platform: "meta",
    label: "Meta (Facebook)",
    titleChain: OG_TITLE,
    titleLimit: 88,
    descChain: OG_DESC,
    descLimit: 200,
    imageChain: OG_IMG,
    dims: { minW: 200, minH: 200, largeW: 600, largeH: 315 },
    layout: ({ img }) => cardLayoutBasic(img, "none"),
    extraWarnings: ({ title, img }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      if (!img.url) w.push(missing("og:image", "warning"));
      if (img.url && !img.meetsMinimum) {
        w.push({
          severity: "warning",
          code: "meta-image-too-small",
          message: "Meta requires an image of at least 200x200; smaller or broken images fall back to text-only.",
        });
      } else if (img.url && !img.rendersAsLarge) {
        w.push({
          severity: "info",
          code: "meta-image-small-card",
          message: "Meta uses a small thumbnail card below 600x315.",
        });
      }
      return w;
    },
  },
  {
    platform: "linkedin",
    label: "LinkedIn",
    titleChain: OG_TITLE,
    titleLimit: 70,
    descChain: OG_DESC,
    descLimit: 256,
    imageChain: OG_IMG,
    dims: { minW: 200, minH: 200, largeW: 1200, largeH: 200 },
    layout: ({ img }) => cardLayoutBasic(img, "none"),
    extraWarnings: ({ title, img }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      if (!img.url) {
        w.push({
          severity: "warning",
          code: "linkedin-no-image",
          message: "LinkedIn renders a text-only card without og:image.",
        });
      } else if (!img.rendersAsLarge) {
        w.push({
          severity: "warning",
          code: "linkedin-image-too-small",
          message: "LinkedIn recommends at least 1200x627 for the large card layout.",
        });
      }
      w.push({
        severity: "info",
        code: "linkedin-cache",
        message: "LinkedIn caches link previews for about 7 days (use Post Inspector to refresh).",
      });
      return w;
    },
  },
  {
    platform: "pinterest",
    label: "Pinterest",
    titleChain: OG_TITLE,
    titleLimit: 100,
    descChain: OG_DESC,
    descLimit: 300,
    imageChain: OG_IMG,
    dims: { minW: 600, minH: 400, largeW: 1000, largeH: 1500 },
    layout: ({ img }) => (img.url ? (img.rendersAsLarge ? "large" : "summary") : "none"),
    extraWarnings: ({ title, img }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      if (!img.url) {
        w.push({
          severity: "warning",
          code: "pinterest-no-image",
          message: "Pinterest requires og:image to render a pin preview.",
        });
      } else if (!img.rendersAsLarge) {
        w.push({
          severity: "warning",
          code: "pinterest-image-not-vertical",
          message: "Pinterest prefers tall 2:3 images (around 1000x1500).",
        });
      }
      return w;
    },
  },
  {
    platform: "slack",
    label: "Slack",
    titleChain: OG_TW_TITLE,
    titleLimit: 80,
    descChain: OG_TW_DESC,
    descLimit: 200,
    imageChain: OG_TW_IMG,
    dims: { minW: 1, minH: 1, largeW: 1, largeH: 1 },
    layout: ({ img, title, description }) =>
      img.url || title.value || description.value ? "inline" : "none",
    extraWarnings: ({ title, description }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      if (!description.value) w.push(missing("og:description", "info"));
      return w;
    },
  },
  {
    platform: "discord",
    label: "Discord",
    titleChain: OG_TW_TITLE,
    titleLimit: 256,
    descChain: OG_TW_DESC,
    descLimit: 350,
    imageChain: OG_TW_IMG,
    dims: { minW: 1, minH: 1, largeW: 1, largeH: 1 },
    layout: ({ meta, img, title }) => {
      const wantsLarge = meta.twitterCard?.toLowerCase() === "summary_large_image";
      if (img.url && img.meetsMinimum) return wantsLarge ? "large" : "inline";
      return title.value ? "inline" : "none";
    },
    extraWarnings: ({ meta, title, img }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      const wantsLarge = meta.twitterCard?.toLowerCase() === "summary_large_image";
      if (img.url && !wantsLarge) {
        w.push({
          severity: "info",
          code: "discord-small-embed",
          message: 'Set twitter:card="summary_large_image" for a full-width Discord embed image.',
        });
      }
      return w;
    },
  },
  {
    platform: "whatsapp",
    label: "WhatsApp",
    titleChain: OG_TITLE,
    titleLimit: 60,
    descChain: OG_DESC,
    descLimit: 120,
    imageChain: OG_IMG,
    dims: { minW: 300, minH: 200, largeW: 1200, largeH: 630 },
    layout: ({ img, title }) => (img.url && img.meetsMinimum ? "large" : title.value ? "inline" : "none"),
    extraWarnings: ({ title, img, image }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      if (img.url && image?.sizeBytes && image.sizeBytes > 600 * 1024) {
        w.push({
          severity: "warning",
          code: "whatsapp-image-too-large",
          message: "WhatsApp prefers og:image under 600 KB; larger files may fail to preview.",
        });
      }
      return w;
    },
  },
  {
    platform: "telegram",
    label: "Telegram",
    titleChain: OG_TW_TITLE,
    titleLimit: 80,
    descChain: OG_TW_DESC,
    descLimit: 200,
    imageChain: OG_TW_IMG,
    dims: { minW: 300, minH: 200, largeW: 1200, largeH: 630 },
    layout: ({ meta, img }) => {
      if (!img.url) return "inline";
      const wantsLarge = meta.twitterCard?.toLowerCase() === "summary_large_image";
      return wantsLarge && img.rendersAsLarge ? "large" : "summary";
    },
    extraWarnings: ({ title }) => (title.value ? [] : [missing("og:title", "warning")]),
  },
  {
    platform: "bluesky",
    label: "Bluesky",
    titleChain: OG_TW_TITLE,
    titleLimit: 80,
    descChain: OG_TW_DESC,
    descLimit: 200,
    imageChain: OG_TW_IMG,
    dims: { minW: 400, minH: 400, largeW: 1200, largeH: 630 },
    layout: ({ img, title }) =>
      img.url ? (img.rendersAsLarge ? "large" : "summary") : title.value ? "inline" : "none",
    extraWarnings: ({ title }) => (title.value ? [] : [missing("og:title", "warning")]),
  },
  {
    platform: "mastodon",
    label: "Mastodon",
    titleChain: OG_TW_TITLE,
    titleLimit: 80,
    descChain: OG_TW_DESC,
    descLimit: 200,
    imageChain: OG_TW_IMG,
    dims: { minW: 300, minH: 200, largeW: 1200, largeH: 630 },
    layout: ({ img }) => (img.url ? (img.rendersAsLarge ? "large" : "summary") : "inline"),
    extraWarnings: ({ title }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      w.push({
        severity: "info",
        code: "mastodon-cache",
        message: "Mastodon instances cache link previews after first fetch.",
      });
      return w;
    },
  },
  {
    platform: "imessage",
    label: "iMessage",
    titleChain: OG_TITLE,
    titleLimit: 60,
    descChain: null,
    imageChain: OG_IMG,
    dims: { minW: 144, minH: 144, largeW: 800, largeH: 800 },
    layout: ({ img, title }) => (img.url ? "summary" : title.value ? "inline" : "none"),
    extraWarnings: ({ title, img }) => {
      const w: Warning[] = [];
      if (!title.value) w.push(missing("og:title", "warning"));
      if (img.url && !img.meetsMinimum) {
        w.push({
          severity: "info",
          code: "imessage-image-small",
          message: "iMessage prefers images of at least 144x144.",
        });
      }
      return w;
    },
  },
];

/** Build approximate link previews for all supported platforms. */
export function platformPreviews(
  meta: SocialMeta,
  image: ImageAudit | null,
  images?: ImageAudit[],
): PlatformPreview[] {
  const [metaRule, linkedinRule, ...rest] = RULES;
  return [
    applyRule(metaRule, meta, image, images),
    applyRule(linkedinRule, meta, image, images),
    previewX(meta, image, images),
    ...rest.map((rule) => applyRule(rule, meta, image, images)),
  ];
}

function applyRule(
  rule: PlatformRule,
  meta: SocialMeta,
  image: ImageAudit | null,
  images?: ImageAudit[],
): PlatformPreview {
  const title = pickTitle(meta, rule.titleChain, rule.titleLimit);
  const description =
    rule.descChain == null
      ? emptyField()
      : pickDescription(meta, rule.descChain, rule.descLimit ?? 200);
  const { img, probe } = pickImage(meta, image, images, rule.imageChain, rule.dims);
  const ctx: PreviewCtx = { meta, image: probe, title, description, img };
  return {
    platform: rule.platform,
    label: rule.label,
    cardLayout: rule.layout(ctx),
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings: rule.extraWarnings?.(ctx) ?? [],
  };
}

function previewX(
  meta: SocialMeta,
  image: ImageAudit | null,
  images?: ImageAudit[],
): PlatformPreview {
  const title = pickTitle(meta, ["twitter:title", "og:title", "<title>"], 70);
  const description = pickDescription(
    meta,
    ["twitter:description", "og:description", "meta description"],
    200,
  );

  const declaredCard = meta.twitterCard?.toLowerCase();
  const wantsLarge = declaredCard === "summary_large_image";
  const minDims = wantsLarge ? { minW: 300, minH: 157 } : { minW: 144, minH: 144 };
  const { img } = pickImage(meta, image, images, ["twitter:image", "og:image"], {
    ...minDims,
    largeW: wantsLarge ? 300 : 9999,
    largeH: wantsLarge ? 157 : 9999,
  });

  const warnings: Warning[] = [];
  if (!declaredCard) {
    warnings.push({
      severity: "warning",
      code: "x-missing-card",
      message: 'X expects twitter:card ("summary_large_image" or "summary").',
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
      message: `twitter:card="${declaredCard}" is not a valid X card type.`,
    });
  }
  if (wantsLarge && img.url && !img.meetsMinimum) {
    warnings.push({
      severity: "warning",
      code: "x-image-too-small",
      message: "summary_large_image requires a valid raster image of at least 300x157.",
    });
  }

  return {
    platform: "x",
    label: "X (Twitter)",
    cardLayout: cardLayoutForX(declaredCard, img),
    title,
    description,
    image: img,
    url: meta.url,
    siteName: meta.siteName,
    warnings,
  };
}

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

function emptyField(): PlatformField {
  return { value: null, source: null, truncated: false, charLimit: null };
}

function pickImage(
  meta: SocialMeta,
  primaryImage: ImageAudit | null,
  images: ImageAudit[] | undefined,
  chain: ImageSource[],
  dims: ImageDims,
): { img: PlatformImage; probe: ImageAudit | null } {
  let chosenSource: ImageSource | null = null;
  let url: string | null = null;
  for (const source of chain) {
    const v =
      source === "og:image"
        ? (meta.raw.openGraph["image"]?.[0] ?? meta.raw.openGraph["image:url"]?.[0])
        : meta.raw.twitter["image"]?.[0];
    if (v) {
      chosenSource = source;
      url = v;
      break;
    }
  }

  const probe = !url
    ? null
    : images !== undefined
      ? (images.find((i) => i.source === url) ?? null)
      : primaryImage;

  if (!url) {
    return {
      img: { url: null, source: null, meetsMinimum: false, rendersAsLarge: false },
      probe: null,
    };
  }

  if (probe === null) {
    // Image validation was skipped (--no-images); assume present URL is usable.
    return {
      img: { url, source: chosenSource, meetsMinimum: true, rendersAsLarge: false },
      probe: null,
    };
  }

  const isRaster = probe.format !== "svg" && probe.contentType !== "image/svg+xml";
  const decoded = probe.found && probe.width !== null && probe.height !== null && isRaster;
  const meetsMinimum = decoded && probe.width! >= dims.minW && probe.height! >= dims.minH;
  const rendersAsLarge = decoded && probe.width! >= dims.largeW && probe.height! >= dims.largeH;

  return {
    img: { url, source: chosenSource, meetsMinimum, rendersAsLarge },
    probe,
  };
}

function cardLayoutBasic(image: PlatformImage, empty: CardLayout): CardLayout {
  if (!image.url) return empty;
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
