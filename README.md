# pi-gh-cli (Fateblade fork)

> **This is a fork of [`sfroment/pi-gh-cli`](https://github.com/sfroment/pi-gh-cli).**
> It tracks upstream and adds a stricter security posture plus fork-specific
> packaging (this fork does **not** publish to npm). Install from this fork:
> `pi install git:github.com/Fateblade/pi-gh-cli`. Upstream is the canonical
> source — see the [Links](#links) section.

[![CI](https://github.com/Fateblade/pi-gh-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Fateblade/pi-gh-cli/actions/workflows/ci.yml)
[![Release](https://github.com/Fateblade/pi-gh-cli/actions/workflows/release.yml/badge.svg)](https://github.com/Fateblade/pi-gh-cli/actions/workflows/release.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Fateblade/pi-gh-cli.svg?cacheSeconds=120)](https://github.com/Fateblade/pi-gh-cli/releases)
[![GitHub stars](https://img.shields.io/github/stars/Fateblade/pi-gh-cli.svg?cacheSeconds=120)](https://github.com/Fateblade/pi-gh-cli/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/Fateblade/pi-gh-cli.svg?cacheSeconds=120)](https://github.com/Fateblade/pi-gh-cli/commits)
[![GitHub commits since latest release](https://img.shields.io/github/commits-since/Fateblade/pi-gh-cli/latest.svg?cacheSeconds=120)](https://github.com/Fateblade/pi-gh-cli/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](https://github.com/Fateblade/pi-gh-cli/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-fd4b3a?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A [pi coding agent](https://github.com/earendil-works/pi-mono) extension that wraps the GitHub `gh` CLI as a single typed tool — **directly**, not via an MCP server.

## What it provides

- a `gh` custom tool with typed parameters (`subcommand` + `args` map + `repo` + `jsonFields` + `jq` + `limit` + `timeoutSeconds` + `forceDangerous`)
- a bundled `SKILL.md` documenting the tool and common `gh` commands
- per-turn prompt guidance when a prompt mentions GitHub, PRs, issues, repos, releases, workflows, or gists
- graceful detection of the "not authenticated" failure with actionable guidance
- a safety guard that refuses dangerous operations — `repo delete`, `release delete`, `codespace delete`, `extension install/upgrade`, `codespace ssh/cp`, `alias set/delete`, `config set`, and mutating `gh api` calls (POST/PUT/PATCH/DELETE, body-carrying requests, `api graphql`) — unless `forceDangerous: true` is set, and even then only after the user confirms via the runtime dialog
- token redaction: credential-shaped strings (gh tokens, fine-grained PATs) are stripped from tool output before entering model context

## Why not MCP?

The `gh` CLI already exposes the full GitHub API (repos, PRs, issues, releases, Actions, gists) and uses the user's existing `gh auth login` credentials. Wrapping it in a typed pi tool gives structured, discoverable parameters and output truncation without an extra server process.

## Requirements

- `gh` CLI on PATH — [cli.github.com](https://cli.github.com/)
- Authenticated via `gh auth login`

## Installation

Drop the extension into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local), then reload:

```text
/reload
```

Or install from git:

```bash
pi install git:github.com/Fateblade/pi-gh-cli
```

## Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `subcommand` | `string` | The full gh subcommand path (e.g. `"pr list"`, `"repo view"`, `"issue view 42"`). Top-level — never nest inside `args`. |
| `args` | `object` | A key/value object of flags ONLY — **never an array**, and do not nest `subcommand`/`jsonFields`/`jq`/`repo`/`limit` here. Booleans → bare `--flag` (`{web: true}` → `--web`). Strings/numbers → `--flag value` (`{state: "open"}` → `--state open`). Arrays → repeated `--flag value` pairs (`{label: ["bug","urgent"]}` → `--label bug --label urgent`). |
| `repo` | `string` | Target repository as `owner/repo` (→ `--repo owner/repo`). |
| `jsonFields` | `string[]` | Fields to return as JSON (→ `--json field1,field2`). |
| `jq` | `string` | jq expression to filter JSON output (→ `--jq expr`). |
| `limit` | `integer` | Maximum results (→ `--limit N`). **Only list-style commands accept it** — view commands reject it; the tool refuses such calls with a working form. |
| `timeoutSeconds` | `integer` | Command timeout (default 30, max 120). |
| `forceDangerous` | `boolean` | Opt-in for dangerous commands (`repo delete`, `release delete`, `codespace delete`, mutating `gh api` calls, `extension install/upgrade`, `codespace ssh/cp`, `alias set/delete`, `config set`). The user is still asked to confirm via a dialog before execution. |

## Examples

List open PRs in a repo:

```json
{
  "subcommand": "pr list",
  "args": { "state": "open" },
  "repo": "owner/repo",
  "jsonFields": ["number", "title", "state"],
  "limit": 10
}
```

View a specific issue:

```json
{
  "subcommand": "issue view 42",
  "repo": "owner/repo",
  "args": { "comments": true }
}
```

## Security

The tool is read-first by default:

- Destructive and code-execution operations (`repo delete`, `release delete`, `codespace delete`, `extension install/upgrade`, `codespace ssh/cp`, `alias set/delete`, `config set`) are refused unless `forceDangerous: true` is set.
- Mutating raw API calls (`gh api` with POST/PUT/PATCH/DELETE, body-carrying flags, or `api graphql`) are gated the same way; read-only `GET` calls need no opt-in.
- Even with `forceDangerous: true`, the runtime shows a confirmation dialog and the user must approve before the command runs.
- Credential-shaped strings (gh tokens, fine-grained PATs) are redacted from tool output before entering model context.
- `gh` runs via an argv array (no shell interpolation), and output is truncated to 2000 lines / 50 KB.

## Development

```bash
bun test          # pretest links pi runtime deps automatically
bunx tsc --noEmit # type-check
```

Releases are tag-driven. Bump `version` in `package.json`, then push a matching tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The tag creates a GitHub Release. This fork does not publish to npm.

## License

GPL-3.0

## Links

- **This fork:** <https://github.com/Fateblade/pi-gh-cli>
- **Fork issues:** <https://github.com/Fateblade/pi-gh-cli/issues>
- **Upstream source:** <https://github.com/sfroment/pi-gh-cli>
- **Upstream author:** [Sacha Froment](https://sacha42.com)
