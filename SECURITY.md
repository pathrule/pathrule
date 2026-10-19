# Security policy

We take the security of Pathrule seriously. Thank you for helping keep its users safe.

## Reporting a vulnerability

Please do **not** report security vulnerabilities through public GitHub issues, discussions or pull
requests.

Report them privately instead, by either:

- opening a [private vulnerability report](https://github.com/pathrule/pathrule/security/advisories/new)
  on GitHub (preferred), or
- emailing **security@pathrule.io**.

Please include as much of the following as you can:

- the type of issue and its impact, including how an attacker could exploit it;
- the affected package, version or commit, and the configuration needed to reproduce it;
- step-by-step instructions to reproduce it, ideally with a minimal proof of concept;
- any logs or output, with secrets and personal data removed.

Reports in English are preferred.

## What happens next

1. We acknowledge your report within three business days.
2. We confirm the issue, assess its severity and keep you informed while we work on a fix.
3. We agree a disclosure date with you, release the fix and publish a GitHub security advisory,
   requesting a CVE where one is warranted.
4. We credit you in the advisory, unless you prefer to stay anonymous.

Please give us a reasonable time to release a fix before you disclose the issue publicly.

## Supported versions

Security fixes are released for the latest minor version. Before you report, please check that the
issue still occurs on the latest release.

| Version | Supported |
| --- | --- |
| 1.0.x | :white_check_mark: |
| < 1.0 | :x: |

## Scope

In scope is everything in this repository: the packages under `packages/` (the knowledge store,
retrieval, the MCP server, the hooks, the CLI, the Local Console, the VS Code extension and the open
Pathrule Cloud client) and the scripts that build and release them.

Pathrule's hosted services (Pathrule Cloud, its web console and the Remote MCP endpoint) are not part
of this repository. Please report issues in them to **security@pathrule.io** as well.
