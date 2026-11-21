import { readFileSync, rmSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

const shared = {
  format: ["esm"] as const,
  target: "node18" as const,
  clean: false,
  splitting: false,
  sourcemap: false,
  shims: false,
  define: {
    __SHIPCARD_VERSION__: JSON.stringify(pkg.version),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    dts: true,
  },
  {
    ...shared,
    entry: ["src/cli.ts"],
    dts: false,
    external: ["./index.js"],
  },
]);
