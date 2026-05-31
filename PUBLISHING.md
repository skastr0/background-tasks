# Publishing Plan

This repository is prepared for a first experimental npm release, but no public package, repository visibility change, tag, workflow dispatch, or registry upload is authorized by this file.

## Package Set

Publish these packages to npm under the `@skastr0` scope:

- `@skastr0/background-tasks-core`: reusable task lifecycle, log, CLI-store, and control-plane primitives.
- `@skastr0/background-tasks`: npm runner package exposing the `background-tasks` command through a Node launcher.
- `@skastr0/background-tasks-darwin-arm64`: macOS arm64 standalone CLI binary.
- `@skastr0/background-tasks-darwin-x64`: macOS x64 standalone CLI binary.
- `@skastr0/background-tasks-linux-arm64`: Linux arm64 standalone CLI binary.
- `@skastr0/background-tasks-linux-x64`: Linux x64 standalone CLI binary.
- `@skastr0/background-tasks-opencode`: OpenCode server and TUI integration exposing `exports["./server"]` and `exports["./tui"]`.

The root workspace package remains private and is not a publish target. `apps/cli` is a private source workspace and is not a publish target.

## Channel Strategy

The first public channel is npm only. Publish order is:

1. `@skastr0/background-tasks-core`
2. `@skastr0/background-tasks-darwin-arm64`
3. `@skastr0/background-tasks-darwin-x64`
4. `@skastr0/background-tasks-linux-arm64`
5. `@skastr0/background-tasks-linux-x64`
6. `@skastr0/background-tasks`
7. `@skastr0/background-tasks-opencode`

The public CLI package follows the Bun-native binary topology used by `../pulsar`: the installable package is a tiny Node launcher, and each platform package carries one compiled Bun standalone binary. This supports `npx`, `bunx`, and `pnpm dlx` on the supported OS/CPU pairs without requiring Bun on the user's machine.

GitHub Releases and Homebrew are deferred. JSR is deferred. The package surface currently includes Bun-oriented TypeScript source, compiled CLI binaries, and OpenCode plugin entrypoints, so npm is the narrowest correct first lane.

## CLI Binary Topology

The private source workspace is `apps/cli`. It compiles into standalone Bun binaries with:

```sh
bun run build:npm-cli
```

The build produces `dist/background-tasks-{platform}-{arch}` and copies each binary into the matching platform package under `packages/npm/background-tasks-*`.

The public `@skastr0/background-tasks` package contains only:

- `bin/background-tasks.js`: Node launcher
- `README.md`
- `LICENSE`
- optional dependencies pointing at exact-version platform packages

The launcher resolves the platform package for `process.platform` and `process.arch`, then executes `bin/background-tasks` from that package.

## OpenCode Plugin Install Shape

OpenCode npm plugins are added to config by package name and installed by OpenCode. For package-based installation, OpenCode detects plugin targets from package metadata:

- server plugin: `exports["./server"]` or `main`
- TUI plugin: `exports["./tui"]`

Use this config entry after npm publication:

```json
{
  "plugin": ["@skastr0/background-tasks-opencode"]
}
```

Use the same package name in the relevant server and TUI config files. If using the OpenCode plugin installer, the package metadata should let OpenCode patch both server and TUI config files automatically.

## Authority Model

Default publish authority is CI-first through GitHub Actions and npm trusted publishing. Local maintainers and agents may inspect, edit, build, test, pack, and dry-run packages.

Human approval is required before:

- making the repository public
- configuring npm trusted publishers or registry credentials
- creating or pushing release tags
- dispatching or approving the npm publish workflow
- publishing any npm package
- changing package visibility, ownership, dist-tags, deprecation, or access
- creating GitHub Releases or publishing binary assets
- pushing Homebrew tap changes

Use a protected GitHub Actions environment named `release` for publish jobs.

## Local Verification

Before first publish:

```sh
bun install
bun run verify
bun run smoke:npm-cli
bun run pack:dry-run
```

Inspect the `npm pack --dry-run` output for each package and confirm:

- expected source files are present
- expected platform binaries are present in platform package tarballs
- package-local `README.md`, package metadata, and license fields are present
- package tarballs do not include logs, state, credentials, local payloads, or generated private artifacts
- sibling workspace dependencies are exact registry versions, not `workspace:*`

## First Publish Steps

1. Approve repository visibility and package names.
2. Ensure each npm package name is available or intentionally reserved.
3. Configure npm trusted publishing for `.github/workflows/npm-publish.yml`.
4. Configure the GitHub `release` environment with maintainer approval.
5. Run local verification and inspect package dry-runs.
6. Commit release preparation.
7. With explicit approval, push a `v0.1.0` tag or manually dispatch the publish workflow.
8. Approve the protected `release` environment job.
9. Verify each npm package page, install metadata, repository link, license, and provenance.
10. Smoke test package installation from a clean temporary directory.

## Rollback Notes

npm package versions should be treated as permanent. Prefer publishing a fixed version over relying on unpublish. If a bad first release happens, deprecate the affected version with a clear replacement message and publish a corrected patch version.
