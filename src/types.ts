export type Severity = "info" | "warning" | "error";

export type Warning = {
  severity: Severity;
  code: string;
  message: string;
};

export type SiteWarning = Warning & {
  pages: string[];
};

export type SkippedPage = {
  path: string;
  reason: "ignored" | "redirect";
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

export type CheckStatus = "pass" | "partial" | "fail" | "skipped";

export type CheckResult = {
  id: string;
  label: string;
  passed: boolean;
  status: CheckStatus;
  weight: number;
  earned: number;
};

export type PageStatus = "pass" | "warn" | "fail";

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
  source: string | null;
  truncated: boolean;
  charLimit: number | null;
};

export type PlatformImage = {
  url: string | null;
  source: "og:image" | "twitter:image" | null;
  meetsMinimum: boolean;
  rendersAsLarge: boolean;
};

export type PlatformPreview = {
  platform: Platform;
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
  /** Primary image probe (first og:image, else first twitter:image). */
  image: ImageAudit | null;
  /** Every distinct social image validated on the page. */
  images?: ImageAudit[];
  checks: CheckResult[];
  warnings: Warning[];
  platforms: PlatformPreview[];
};

export type TargetType = "url" | "folder" | "file" | "stdin" | "sitemap";

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
    minScore: number;
    pagesScanned: number;
    passed: number;
    warnings: number;
    failed: number;
    skipped?: number;
  };
  pages: PageReport[];
  siteWarnings?: SiteWarning[];
  skipped?: SkippedPage[];
};

export type AuditOptions = {
  baseUrl?: string;
  baseDir?: string;
  validateImages?: boolean;
  offline?: boolean;
  timeoutMs?: number;
  version?: string;
  /** Glob patterns of logical paths or basenames to skip (e.g. "404.html", "/admin/**"). */
  ignore?: string[];
  /** Include <meta http-equiv="refresh"> redirect stub pages in multi-page audits. Default false. */
  includeRedirects?: boolean;
  /** Treat a URL target as an XML sitemap even if the URL does not end in .xml. */
  sitemap?: boolean;
  /** Maximum pages to fetch when auditing a sitemap (default 50). */
  maxPages?: number;
};
