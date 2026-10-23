import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

test("standalone release retains plugin metadata without requiring bundled build dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-package-"));
  try {
    const pkg = { name: "openclaw-otel-plugin", version: "0.8.1-rc.1", type: "module",
      openclaw: { extensions: ["./dist/index.cjs"] },
      dependencies: { "@opentelemetry/api": "^1.9.0" }, devDependencies: { esbuild: "^0.27.4" } };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist/index.cjs"), "module.exports = {};\n");
    fs.mkdirSync(path.join(root, "scripts"));
    for (const file of ["install.sh", "install.ps1"]) fs.writeFileSync(path.join(root, "scripts", file), "fixture installer\n");
    for (const file of ["openclaw.plugin.json", "README.md", "README_ZH.md", "LICENSE"]) {
      fs.writeFileSync(path.join(root, file), file === "openclaw.plugin.json" ? '{"id":"openclaw-otel-plugin"}' : "fixture\n");
    }
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/release.mjs", import.meta.url))], { cwd: root });
    const archive = path.join(root, "output/openclaw-otel-plugin-v0.8.1-rc.1.tar.gz");
    const saved = JSON.parse(execFileSync("tar", ["-xOf", archive, "openclaw-otel-plugin-v0.8.1-rc.1/package.json"], { encoding: "utf8" }));
    assert.equal(saved.version, pkg.version);
    assert.deepEqual(saved.openclaw, pkg.openclaw);
    assert.equal(saved.dependencies, undefined);
    assert.equal(saved.devDependencies, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "package.json"))), pkg);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
