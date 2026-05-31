# @skastr0/background-tasks-opencode

OpenCode server and TUI integration for `background-tasks`.

This single package exposes both OpenCode plugin targets:

- `exports["./server"]`: server plugin tools for starting, listing, reading logs, stopping, and restarting local background tasks associated with an OpenCode session.
- `exports["./tui"]`: TUI plugin controls for session-aware background task workflows.

## OpenCode Config

After the package is published, add it to the relevant OpenCode config files:

```json
{
  "plugin": ["@skastr0/background-tasks-opencode"]
}
```

OpenCode's plugin installer can detect both targets from package metadata and patch both server and TUI config when the host supports package installation.

See the repository README and `SECURITY.md` before using it with commands that may capture sensitive logs or environment values.
