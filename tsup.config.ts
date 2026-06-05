import { defineConfig } from "tsup";
import pkg from "./package.json" assert { type: "json" };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
  define: {
    __SHIPCARD_VERSION__: JSON.stringify(pkg.version),
  },
});
