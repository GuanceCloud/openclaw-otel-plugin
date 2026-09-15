import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

await rm("dist", { recursive: true, force: true });

const define = {
  __OPENCLAW_OTEL_PLUGIN_VERSION__: JSON.stringify(packageJson.version),
};

await build({
  entryPoints: ["index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  define,
  external: ["openclaw/plugin-sdk/*"],
  outfile: "dist/index.cjs",
});

await build({
  entryPoints: [
    "src/config.ts",
    "src/plugin-version.ts",
    "src/service.ts",
    "src/otel-bootstrap.ts",
    "src/session-store.ts",
    "src/service-utils.ts",
    "src/tool-span-manager.ts",
    "src/diagnostic-event-handler.ts",
  ],
  platform: "node",
  format: "esm",
  target: "node22",
  define,
  outdir: "dist",
  outbase: ".",
});

await mkdir("dist/src", { recursive: true });
await cp("src/trace-runtime.js", "dist/src/trace-runtime.js");
