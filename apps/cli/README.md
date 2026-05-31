# background-tasks CLI Source

Private Bun source workspace for the `background-tasks` CLI.

The public npm CLI package is `@skastr0/background-tasks`. It ships a Node launcher plus platform-specific standalone Bun binaries under `packages/npm/background-tasks-*`.

## Build

```sh
bun run build:npm-cli
```

## Usage

```sh
background-tasks capabilities
background-tasks start '{"id":"bg_demo","command":"sleep","args":["60"]}'
background-tasks status '{"id":"bg_demo"}'
```

See the repository README for the JSON payload contract, local state paths, and security boundaries.
