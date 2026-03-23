import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const watchTargets = ["index.ts", "openclaw.plugin.json", "src"];
const watchExtensions = new Set([".ts", ".js", ".json"]);

let rebuildTimer = null;
let buildRunning = false;
let queued = false;

function log(message) {
  process.stdout.write(`[dev] ${message}\n`);
}

function shouldWatch(filePath) {
  const base = path.basename(filePath);
  if (base.startsWith(".")) return false;
  if (base === "dist" || base === "node_modules" || base === ".git") return false;

  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat?.isDirectory()) return true;
  return watchExtensions.has(path.extname(filePath));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

async function buildAndRestart(reason) {
  if (buildRunning) {
    queued = true;
    return;
  }

  buildRunning = true;
  log(`change detected (${reason}), rebuilding`);

  try {
    const build = await runCommand("npm", ["run", "build"]);
    if (build.code !== 0) {
      log(`build failed with exit code ${build.code}`);
      return;
    }

    const restart = await runCommand("openclaw", ["gateway", "restart"]);
    if (restart.code !== 0) {
      log(`gateway restart failed with exit code ${restart.code}`);
      return;
    }

    log("build and gateway restart completed");
  } finally {
    buildRunning = false;
    if (queued) {
      queued = false;
      void buildAndRestart("queued change");
    }
  }
}

function scheduleBuild(reason) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void buildAndRestart(reason);
  }, 250);
}

function watchDirectory(dirPath) {
  const watchers = new Map();

  function attach(currentPath) {
    if (watchers.has(currentPath) || !fs.existsSync(currentPath)) return;
    if (!shouldWatch(currentPath)) return;

    const stat = fs.statSync(currentPath);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(currentPath)) {
        attach(path.join(currentPath, entry));
      }
    }

    try {
      const watcher = fs.watch(currentPath, { persistent: true }, (_eventType, filename) => {
        if (filename) {
          const nextPath = path.join(currentPath, filename.toString());
          attach(nextPath);
        }
        scheduleBuild(path.relative(repoRoot, currentPath));
      });
      watchers.set(currentPath, watcher);
    } catch (error) {
      log(`watch failed for ${path.relative(repoRoot, currentPath)}: ${error.message}`);
    }
  }

  attach(dirPath);
  return watchers;
}

const watcherMaps = [];
for (const target of watchTargets) {
  const fullPath = path.join(repoRoot, target);
  if (fs.existsSync(fullPath)) {
    watcherMaps.push(watchDirectory(fullPath));
  }
}

process.on("SIGINT", () => {
  for (const map of watcherMaps) {
    for (const watcher of map.values()) watcher.close();
  }
  log("stopped");
  process.exit(0);
});

log("starting initial build");
void buildAndRestart("initial run");
log("watching index.ts, openclaw.plugin.json, and src/");
