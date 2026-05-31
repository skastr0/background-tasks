#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platformKey = `${process.platform}-${process.arch}`;

const packageMap = {
  "darwin-arm64": "@skastr0/background-tasks-darwin-arm64",
  "darwin-x64": "@skastr0/background-tasks-darwin-x64",
  "linux-arm64": "@skastr0/background-tasks-linux-arm64",
  "linux-x64": "@skastr0/background-tasks-linux-x64",
};

const packageName = packageMap[platformKey];

if (packageName === undefined) {
  console.error(`background-tasks: unsupported platform ${platformKey}`);
  process.exit(1);
}

let packageJsonPath;
try {
  packageJsonPath = require.resolve(`${packageName}/package.json`);
} catch {
  console.error(`background-tasks: missing platform package ${packageName}`);
  console.error("Reinstall @skastr0/background-tasks with optional dependencies enabled.");
  process.exit(1);
}

const binaryPath = join(dirname(packageJsonPath), "bin", "background-tasks");

if (!existsSync(binaryPath)) {
  console.error(`background-tasks: platform binary not found at ${binaryPath}`);
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
