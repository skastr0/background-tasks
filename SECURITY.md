# Security Policy

## Supported Status

`background-tasks` is experimental and solo-maintained. Security reports are reviewed on a best-effort basis, without a formal response SLA.

| Version or branch | Supported |
| --- | --- |
| `main` | Yes |
| Published npm packages | Yes, once published |
| Unsupported forks or modified releases | No |

## Reporting A Vulnerability

Do not open a public issue for suspected vulnerabilities.

Report privately through GitHub's private vulnerability reporting for this repository once it is enabled, or contact the maintainer directly if that path is not available.

Include:

- affected version, package, commit, or release artifact
- reproduction steps
- expected impact
- relevant logs, proof of concept, or package metadata
- whether the issue appears exploitable in default configuration

Please redact tokens, personal data, private endpoints, and unrelated secrets from reports.

## Scope

In scope:

- CLI payload decoding, task lifecycle behavior, and local state handling
- opencode plugin and TUI integration behavior
- package installation paths and generated release assets
- handling of task logs, artifacts, and user-provided environment variables

Out of scope:

- unsupported versions or forks
- social engineering
- denial-of-service against maintainer-owned infrastructure
- user-provided commands that intentionally perform unsafe local actions
- findings that require already-compromised local machines unless this project increases impact

## Disclosure

The maintainer will coordinate disclosure timing based on severity, available fixes, and user impact. No response-time SLA is promised.

## Supply Chain Notes

Official release channels are not live yet. The intended first public channel is npm under the `@skastr0` scope:

- `@skastr0/background-tasks-core`
- `@skastr0/background-tasks`
- `@skastr0/background-tasks-darwin-arm64`
- `@skastr0/background-tasks-darwin-x64`
- `@skastr0/background-tasks-linux-arm64`
- `@skastr0/background-tasks-linux-x64`
- `@skastr0/background-tasks-opencode`

Do not trust binaries, packages, or install commands from channels not listed here or in `README.md`.
