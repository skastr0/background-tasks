#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const licensePath = join(repoRoot, "LICENSE");

const npmPackageDirs = [
  "packages/npm/background-tasks",
  "packages/npm/background-tasks-darwin-arm64",
  "packages/npm/background-tasks-darwin-x64",
  "packages/npm/background-tasks-linux-arm64",
  "packages/npm/background-tasks-linux-x64",
] as const;

const platformPackages = [
  { target: "darwin-arm64", packageDir: "packages/npm/background-tasks-darwin-arm64" },
  { target: "darwin-x64", packageDir: "packages/npm/background-tasks-darwin-x64" },
  { target: "linux-arm64", packageDir: "packages/npm/background-tasks-linux-arm64" },
  { target: "linux-x64", packageDir: "packages/npm/background-tasks-linux-x64" },
] as const;

const run = async (label: string, command: ReadonlyArray<string>) => {
  console.log(`\n${label}`);
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`${label} failed with exit code ${exitCode}`);
    process.exit(exitCode);
  }
};

await run("Building standalone CLI binaries", ["bun", "run", "scripts/build-cli.ts"]);

for (const packageDir of npmPackageDirs) {
  await copyFile(licensePath, join(repoRoot, packageDir, "LICENSE"));
}

for (const { target, packageDir } of platformPackages) {
  const source = join(repoRoot, "dist", `background-tasks-${target}`);
  const binDir = join(repoRoot, packageDir, "bin");
  const destination = join(binDir, "background-tasks");

  await mkdir(binDir, { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);

  console.log(`Copied ${source} -> ${destination}`);
}
