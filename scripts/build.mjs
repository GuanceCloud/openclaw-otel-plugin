import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["openclaw/plugin-sdk/*"],
  outfile: "dist/index.cjs",
});

await build({
  entryPoints: [
    "src/config.ts",
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
  outdir: "dist",
  outbase: ".",
});

await mkdir("dist/src", { recursive: true });
await cp("src/trace-runtime.js", "dist/src/trace-runtime.js");
