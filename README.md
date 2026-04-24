# Background Tasks

`background-tasks` is an agentic control-plane CLI for local background processes. It starts tasks, keeps lifecycle state in a local store, captures logs, and exposes machine-stable JSON for automation.

## CLI Shape

The CLI is JSON-first. Domain data is passed as a single JSON payload, while flags only control execution behavior.

Payload input modes:

```sh
background-tasks start '{"id":"bg_demo","command":"sleep","args":["60"]}'
background-tasks start @payload.json
cat payload.json | background-tasks start -
```

Execution flags:

- `--output auto|inline|artifact`
- `--wait`
- `--stream`
- `--timeout <seconds>`
- `--concurrency <n>`

Success is written to stdout:

```json
{
  "ok": true,
  "command": "status",
  "data": {}
}
```

Expected failures are written to stderr with exit code `1`:

```json
{
  "ok": false,
  "command": "status",
  "error": {
    "type": "TaskNotFound",
    "message": "task not found: bg_missing",
    "details": {
      "id": "bg_missing",
      "hint": "Run list to discover known task ids.",
      "retryable": false
    }
  }
}
```

## Lifecycle

Core commands:

- `start` submits and starts one task, or a batch of tasks.
- `status` inspects one task.
- `list` lists tasks with optional `ids`, `status`, `tag`, or `tags` filters.
- `wait` blocks until a task reaches `exited`, `killed`, or `failed`.
- `stop` cancels one task, or a batch of tasks.
- `restart` restarts one task, or a batch of tasks.
- `logs` reads bounded task logs.
- `events` emits status/log event frames.

Example:

```sh
background-tasks start '{"id":"bg_demo","command":"sh","args":["-c","printf ready\\\\n; sleep 60"],"tags":["demo"]}'
background-tasks status '{"id":"bg_demo"}'
background-tasks logs --output auto '{"id":"bg_demo","lines":50}'
background-tasks stop '{"id":"bg_demo"}'
```

Batch example:

```sh
background-tasks start --concurrency 2 '[
  {"id":"bg_one","command":"sleep","args":["30"]},
  {"id":"bg_two","command":"sleep","args":["30"]}
]'
```

## Logs And Artifacts

`logs` defaults to a bounded inline preview. When more log lines exist than the requested preview, `--output auto` returns a compact summary plus an artifact record pointing at the full log file.

```json
{
  "kind": "summary+artifact",
  "summary": "Showing 50 of 412 log lines for bg_demo.",
  "artifact": {
    "key": "task.bg_demo.logs",
    "kind": "text",
    "absolute_path": "/abs/path/bg_demo.log",
    "relative_path": "logs/bg_demo.log",
    "size_bytes": 18320
  }
}
```

Use `--stream` with `logs` or `events` for NDJSON event frames, one JSON object per line.

## Discovery

Agents should prefer discovery commands over README scraping:

```sh
background-tasks doctor
background-tasks capabilities
background-tasks schema list
background-tasks schema show start
background-tasks examples list
background-tasks examples show start
```

`schema show` returns JSON Schema generated from the same Effect Schema boundary used to decode payloads.

## Local Build And Install

```sh
bun install
bun run typecheck
bun test
bun run build
bun run build:binary
bun run install:local
```

`install:local` builds a standalone `dist/background-tasks` binary and copies it to `$HOME/.local/bin/background-tasks`.
