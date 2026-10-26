import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../", import.meta.url));
const version = "0.8.1-rc.2";
const archiveName = `openclaw-otel-plugin-v${version}.tar.gz`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-download-"));
  const source = path.join(root, "source"), bin = path.join(root, "bin");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "dist")); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(source, "dist/index.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "openclaw-otel-plugin", version,
    openclaw: { extensions: ["./dist/index.cjs"] } }));
  fs.writeFileSync(path.join(source, "openclaw.plugin.json"), '{"id":"openclaw-otel-plugin"}');
  for (const file of ["README.md", "README_ZH.md", "LICENSE"]) fs.writeFileSync(path.join(source, file), "fixture\n");
  for (const file of ["install.sh", "install.ps1"]) fs.copyFileSync(path.join(repo, "scripts", file), path.join(source, "scripts", file));
  execFileSync(process.execPath, [path.join(repo, "scripts/release.mjs")], { cwd: source });
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env python3
import os,sys,json,shutil,hashlib
from pathlib import Path
a=sys.argv[1:]; url=next(x for x in a if x.startswith(('http://','https://'))); out=a[a.index('-o')+1]
with open(os.environ['REQUEST_LOG'],'a') as f:f.write(json.dumps(url)+'\\n')
p=Path(os.environ['FIXTURE_ARCHIVE'])
if url.endswith('.sha256'):
 digest='0'*64 if os.environ.get('BAD_CHECKSUM') else hashlib.sha256(p.read_bytes()).hexdigest()
 Path(out).write_text(digest+'  fixture.tar.gz\\n')
else:shutil.copyfile(p,out)
`, { mode: 0o755 });
  const config = path.join(root, "config.json"), installed = path.join(root, "plugin"), sdk = path.join(root, "sdk");
  fs.mkdirSync(sdk);fs.writeFileSync(config, '{"plugins":{"allow":["unrelated"],"entries":{"unrelated":{"enabled":false}}}}\n');
  const initial = fs.readFileSync(config);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    OPENCLAW_PLUGIN_DIR: installed, OPENCLAW_CONFIG_FILE: config, OPENCLAW_RUNTIME_ROOT: sdk,
    REQUEST_LOG: path.join(root, "requests.jsonl"), FIXTURE_ARCHIVE: path.join(source, "output", archiveName) };
  delete env.OSS_ENDPOINT;delete env.OPENCLAW_PLUGIN_GITHUB_REPOSITORY;
  const run = (input, extra = {}, packaged = false, configure = false) => {
    const script = packaged ? path.join(source, "output/install-release.sh") : path.join(repo, "scripts/install.sh");
    const args = configure ? ["--type", "gtrace", "--endpoint", "http://127.0.0.1:4318", "--x-token", "fixture-token",
      "--tag", "agent_id=fixture-id", "--tag", "agent_name=fixture-name"] : ["--no-config"];
    return spawnSync("bash", [script, input, ...args, "--no-restart"], { env: { ...env, ...extra }, encoding: "utf8" });
  };
  const requests = () => fs.existsSync(env.REQUEST_LOG) ? fs.readFileSync(env.REQUEST_LOG, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { root, source, config, installed, initial, env, run, requests };
}

const cases = [
  ["GitHub stable latest without OSS", "latest", {}, "https://github.com/GuanceCloud/openclaw-otel-plugin/releases/latest/download/openclaw-otel-plugin.tar.gz"],
  ["GitHub pinned RC without OSS", "v" + version, {}, `https://github.com/GuanceCloud/openclaw-otel-plugin/releases/download/v${version}/${archiveName}`],
  ["OSS root", version, { OSS_ENDPOINT: "https://oss.example/agent_plugins" }, `https://oss.example/agent_plugins/openclaw-otel-plugin/${archiveName}`],
  ["OSS plugin root", "latest", { OSS_ENDPOINT: "https://oss.example/agent_plugins/openclaw-otel-plugin/" }, "https://oss.example/agent_plugins/openclaw-otel-plugin/openclaw-otel-plugin.tar.gz"],
  ["custom archive URL without OSS", "https://packages.example/custom.tar.gz", {}, "https://packages.example/custom.tar.gz"],
];
for (const [name, input, extra, url] of cases) test(`installer download: ${name}`, () => {
  const f = fixture();try {
    const result = f.run(input, extra);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.requests(), [url, url + ".sha256"]);
    assert.deepEqual(fs.readFileSync(f.config), f.initial);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed, "package.json"))).version, version);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("local archive needs neither OSS nor a network download", () => {
  const f = fixture();try {
    const result = f.run(f.env.FIXTURE_ARCHIVE);
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.requests(), []);
    assert.deepEqual(fs.readFileSync(f.config), f.initial);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a published RC installer pins connector's latest argument to its candidate and configures GTrace", () => {
  const f = fixture();try {
    const result = f.run("latest", {}, true, true);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const url = `https://github.com/GuanceCloud/openclaw-otel-plugin/releases/download/v${version}/${archiveName}`;
    assert.deepEqual(f.requests(), [url, url + ".sha256"]);
    const config = JSON.parse(fs.readFileSync(f.config));
    const plugin = config.plugins.entries["openclaw-otel-plugin"].config;
    assert.equal(plugin.headers["X-Token"], "fixture-token");
    assert.equal(plugin.metricsPath, "v1/write/otel-metrics");
    assert.equal(plugin.resourceAttributes.agent_name, "fixture-name");
    assert.equal(config.plugins.entries.unrelated.enabled, false);
    assert.match(fs.readFileSync(path.join(f.source, "output/install-release.ps1"), "utf8"), /\$InstallerReleaseVersion = "0\.8\.1-rc\.2"/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a mismatched GitHub checksum leaves the existing plugin and configuration intact", () => {
  const f = fixture();try {
    fs.mkdirSync(f.installed);fs.writeFileSync(path.join(f.installed, "sentinel"), "old plugin");
    const result = f.run("latest", { BAD_CHECKSUM: "1" });
    assert.notEqual(result.status, 0);assert.match(result.stderr, /sha256 verification failed/);
    assert.equal(fs.readFileSync(path.join(f.installed, "sentinel"), "utf8"), "old plugin");
    assert.deepEqual(fs.readFileSync(f.config), f.initial);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
