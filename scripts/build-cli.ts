#!/usr/bin/env bun

import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");
const entrypoint = join(repoRoot, "apps", "cli", "src", "cli.ts");

const binaryTargets = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64" },
] as const;

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const { platform, arch } of binaryTargets) {
  const target = `${platform}-${arch}`;
  const outfile = join(distDir, `background-tasks-${target}`);

  console.log(`Compiling background-tasks ${target}...`);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    compile: {
      target: `bun-${platform}-${arch}`,
      outfile,
    },
    minify: true,
  });

  if (!result.success) {
    console.error(`Failed to compile ${target}`);
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  await chmod(outfile, 0o755);
}

console.log("Compiled npm CLI binaries.");
