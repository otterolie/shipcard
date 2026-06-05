// Injected at build time by tsup (see tsup.config.ts). Falls back for dev / direct tsx runs.
declare const __SHIPCARD_VERSION__: string | undefined;
export const VERSION =
  (typeof __SHIPCARD_VERSION__ !== "undefined" ? __SHIPCARD_VERSION__ : "0.0.0-dev");
