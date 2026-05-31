# Background Tasks CLI

This package is the npm runner entrypoint for `background-tasks`.

It exposes the `background-tasks` command through a small Node launcher and delegates to the matching prebuilt Bun standalone binary package for the current platform.

```sh
npx @skastr0/background-tasks --version
bunx @skastr0/background-tasks --version
pnpm dlx @skastr0/background-tasks --version
```

The source repository and package documentation live at <https://github.com/skastr0/background-tasks>.
