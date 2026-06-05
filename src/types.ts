export type Severity = "info" | "warning" | "error";

export type Warning = {
  severity: Severity;
  code: string;
  message: string;
};

export type SocialMeta = {
  title: string | null;
  description: string | null;
  image: string | null;
  url: string | null;
  type: string | null;
  siteName: string | null;
  canonical: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  raw: {
    titleTag: string | null;
    metaDescription: string | null;
    openGraph: Record<string, string[]>;
    twitter: Record<string, string[]>;
    links: Record<string, string[]>;
  };
};

export type ImageAudit = {
  source: string;
  resolvedSource: string;
  found: boolean;
  external: boolean;
  contentType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  format: string | null;
  warnings: Warning[];
};

export type CheckResult = {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
};

export type PageStatus = "ready" | "warning" | "fail";

export type Platform =
  | "meta"
  | "linkedin"
  | "x"
  | "pinterest"
  | "slack"
  | "discord"
  | "whatsapp"
  | "telegram"
  | "bluesky"
  | "mastodon"
  | "imessage";

export type CardLayout = "large" | "summary" | "inline" | "none";

export type PlatformField = {
  value: string | null;
  /** Which source tag the platform read from (e.g. "og:title", "twitter:title"), or null when missing. */
  source: string | null;
  truncated: boolean;
  /** The character limit applied, or null if the platform has no documented limit. */
  charLimit: number | null;
};

export type PlatformImage = {
  url: string | null;
  source: "og:image" | "twitter:image" | null;
  /** Whether the image meets the platform's minimum dimensions for its preferred card. */
  meetsMinimum: boolean;
  /** Whether the image qualifies for the platform's large/hero card layout. */
  rendersAsLarge: boolean;
};

export type PlatformPreview = {
  platform: Platform;
  /** Human label, e.g. "Meta (Facebook)". */
  label: string;
  cardLayout: CardLayout;
  title: PlatformField;
  description: PlatformField;
  image: PlatformImage;
  url: string | null;
  siteName: string | null;
  warnings: Warning[];
};

export type PageReport = {
  path: string;
  source: string;
  score: number;
  status: PageStatus;
  meta: SocialMeta;
  image: ImageAudit | null;
  checks: CheckResult[];
  warnings: Warning[];
  platforms: PlatformPreview[];
};

export type TargetType = "url" | "folder";

export type AuditReport = {
  tool: "shipcard";
  version: string;
  createdAt: string;
  target: {
    type: TargetType;
    input: string;
  };
  summary: {
    score: number;
    pagesScanned: number;
    ready: number;
    warnings: number;
    failed: number;
  };
  pages: PageReport[];
};

export type AuditOptions = {
  /** Base URL or folder used to resolve relative image references. */
  baseUrl?: string;
  /** Filesystem root used when resolving local image paths. */
  baseDir?: string;
  /** Whether to fetch and validate referenced images. */
  validateImages?: boolean;
  /** Timeout in ms when fetching remote resources. */
  timeoutMs?: number;
  /**
   * Version string to embed in reports and User-Agent (e.g. "1.2.3").
   * If omitted, the built-in package version is used.
   */
  version?: string;
  /**
   * When generating --preview for folder targets with local images: embed the image
   * contents as data: base64 URIs. This makes the output HTML fully self-contained and
   * portable (images will render even when opened from a different machine or without
   * access to the original filesystem paths). Default false to keep HTML small.
   */
  embedLocalImages?: boolean;
};
