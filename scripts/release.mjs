import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "output");

function log(message) {
  process.stdout.write(`[release] ${message}\n`);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyRecursive(sourcePath, targetPath) {
  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    const entries = await fs.readdir(sourcePath);
    for (const entry of entries) {
      await copyRecursive(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function createArchive(archivePath, sourceDirName) {
  await execFileAsync("tar", ["-czf", archivePath, sourceDirName], {
    cwd: outputDir,
  });
}

async function writeSha256(filePath) {
  const buffer = await fs.readFile(filePath);
  const digest = createHash("sha256").update(buffer).digest("hex");
  const checksumPath = `${filePath}.sha256`;
  const payload = `${digest}  ${path.basename(filePath)}\n`;
  await fs.writeFile(checksumPath, payload, "utf8");
  return checksumPath;
}

async function copyReleaseScript(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const targetPath = path.join(outputDir, path.basename(relativePath));
  await fs.copyFile(sourcePath, targetPath);
  const stat = await fs.stat(sourcePath);
  await fs.chmod(targetPath, stat.mode);
  return targetPath;
}

async function main() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const pluginName = packageJson.name;
  const version = packageJson.version;
  const distDir = path.join(repoRoot, "dist");

  await fs.mkdir(outputDir, { recursive: true });

  if (!(await fileExists(distDir))) {
    throw new Error("dist/ 不存在，请先执行 npm run build");
  }

  const artifactBase = `${pluginName}-v${version}`;
  const stagingDir = path.join(outputDir, artifactBase);
  const archivePath = path.join(outputDir, `${artifactBase}.tar.gz`);
  const latestArchivePath = path.join(outputDir, `${pluginName}.tar.gz`);

  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });
  await fs.rm(`${archivePath}.sha256`, { force: true });
  await fs.rm(latestArchivePath, { force: true });
  await fs.rm(`${latestArchivePath}.sha256`, { force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  const releaseFiles = [
    "dist",
    "openclaw.plugin.json",
    "package.json",
    "README.md",
    "README_ZH.md",
    "LICENSE",
    "scripts/install.sh",
    "scripts/update.sh",
  ];

  for (const relativePath of releaseFiles) {
    const sourcePath = path.join(repoRoot, relativePath);
    const targetPath = path.join(stagingDir, relativePath);
    await copyRecursive(sourcePath, targetPath);
  }

  await fs.writeFile(path.join(stagingDir, "VERSION"), `${version}\n`, "utf8");
  await fs.writeFile(
    path.join(stagingDir, "RELEASE.json"),
    `${JSON.stringify({ name: pluginName, version, builtAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  log(`packaging ${artifactBase}.tar.gz`);
  await createArchive(archivePath, artifactBase);
  const checksumPath = await writeSha256(archivePath);
  await fs.copyFile(archivePath, latestArchivePath);
  const latestChecksumPath = await writeSha256(latestArchivePath);
  const installScriptPath = await copyReleaseScript("scripts/install.sh");
  const updateScriptPath = await copyReleaseScript("scripts/update.sh");

  log(`artifact: ${path.relative(repoRoot, archivePath)}`);
  log(`checksum: ${path.relative(repoRoot, checksumPath)}`);
  log(`latest artifact: ${path.relative(repoRoot, latestArchivePath)}`);
  log(`latest checksum: ${path.relative(repoRoot, latestChecksumPath)}`);
  log(`install script: ${path.relative(repoRoot, installScriptPath)}`);
  log(`update script: ${path.relative(repoRoot, updateScriptPath)}`);
}

main().catch((error) => {
  process.stderr.write(`[release] ${error.message}\n`);
  process.exitCode = 1;
});
