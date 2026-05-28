# Contributing

Thanks for helping improve `background-tasks`.

This project is experimental and solo-maintained. The default contribution path is issues first, not unsolicited large pull requests.

## Good Issues

Open an issue when you can provide:

- a clear problem statement
- reproduction steps or a minimal example
- expected behavior
- actual behavior
- version, commit, operating system, runtime, and package manager details

For proposals, include the maintenance cost: what this adds, removes, or makes harder to support.

## Pull Requests

Small pull requests for clear bugs, documentation corrections, and agreed follow-ups are welcome.

Before opening a larger pull request:

1. Open an issue.
2. Wait for maintainer confirmation that the change fits the project.
3. Keep the implementation scoped to the accepted behavior.

Unsolicited large rewrites, new subsystems, broad formatting changes, generated churn, or unrelated dependency updates may be closed without review.

## Development

```sh
bun install
bun run verify
bun run pack:dry-run
```

Before submitting:

- run tests and package-content checks
- update docs only when behavior changes
- avoid committing generated artifacts unless the maintainer asks for them
- do not include secrets, private URLs, customer data, local state, or scanner output

## Security

Do not report suspected vulnerabilities in public issues or pull requests. Use the private process in `SECURITY.md`.

## Conduct

Be direct, specific, and respectful. Maintainers may close issues or pull requests that are hostile, off-topic, spammy, or outside the project's stated scope.

By contributing, you agree that your contribution is licensed under the MIT license used by this project.
