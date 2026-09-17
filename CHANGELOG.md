# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `assertLimitUsage` guard: `limit` on `view` commands (`pr`, `issue`, `run`, `release`, `repo`, `gist`, `codespace`, `workflow`, `ruleset`, `project` view) is refused with a working-form error instead of the CLI's bare "unknown flag: --limit" (flag-shaped `args.limit` included; retry suggestion tailored per pair — jsonFields where the view supports `--json`, plain output otherwise).

### Changed

- `limit` guidance in the tool description, prompt guidelines, and skill now states that only list-style commands accept `--limit`.
- Removed environment-specific references from docs and packaging (author email domain).
- Made `scripts/link-pi-deps.sh` portable (PI_RUNTIME_DIR override + `npm root -g`, no hardcoded paths).
- Regenerated `bun.lock` against the public npm registry (format v2, no registry URLs); CI and release workflows bumped to bun 1.4 for the lockfile format, with a Type-check step (`tsc --noEmit`, pinned `typescript` devDependency) added to both.
- Tool description, prompt guidelines, schema description, `GH_GUIDANCE`,
  `SKILL.md`, and `README.md` updated to document the expanded guard list,
  the confirmation dialog, and the `gh api` read-only-by-default policy.
- Tests: new coverage for the api-method guard, expanded dangerous list,
  redaction, and confirmation-dialog flow (decline blocks execution without
  invoking the CLI).

### Security (audit fixes)

- **Dangerous-command guard expanded and hardened** (audit H1, M2):
  - `gh api` calls that mutate state are now gated: any explicit POST/PUT/PATCH/
    DELETE method (`-X`/`--method`, in the subcommand or the args map), any
    body-carrying call (`-f`/`-F`/`--field`/`--raw-field`/`--input`, which
    default to POST), and `api graphql` all require `forceDangerous: true`.
    Previously `gh api -X DELETE ...` could bypass the destructive guard
    entirely.
  - `extension install`/`extension upgrade` (arbitrary code execution),
    `codespace ssh`/`codespace cp` (shell/file access), and `alias set`/
    `alias delete`/`config set` (config tampering) join the dangerous list.
- **Enforced user confirmation for dangerous operations** (audit M1):
  `forceDangerous: true` no longer bypasses the guard by itself. The tool now
  shows a runtime confirmation dialog (`ui.confirm`) before executing any
  dangerous operation; declining aborts the command. Headless callers that
  pass no UI keep the previous opt-in-only behavior.
- **Token redaction** (audit H2): credential-shaped strings (gh CLI tokens
  `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, fine-grained `github_pat_` PATs) are
  redacted from tool stdout/stderr before output enters model context. Commit
  SHAs and other 40-hex strings are unaffected.
- **Supply chain hardening** (audit M3, M4): Dependabot auto-merge is now
  restricted to patch updates only (minor/major require manual review, since
  the release workflow auto-publishes to npm); all GitHub Actions are pinned
  to commit SHAs instead of movable version tags.

### Fork

- Synced with upstream through `f4d29f4`: brings the `--limit` guard for `view`
  commands (`30082a3`), the dev-dependency bumps, and the Dependabot
  `fetch-metadata` v3 bump. Conflicts resolved: kept this fork's SHA-pinned
  Actions policy, merged both CHANGELOG entry sets, and fixed an `args` test
  that failed the newly added `tsc --noEmit` gate.
- This fork no longer publishes to npm: the release workflow creates a GitHub
  Release only, `prepublishOnly` was removed, and the README marks the project
  as a fork of `sfroment/pi-gh-cli`.

### Release process

- Releases are now **tag-driven**: pushing a `v*` tag creates the GitHub Release
  and the tag name is the version.
- Removed the `run_number`-based scheme. It derived the tag from
  `package.json` MAJOR.MINOR plus the workflow run number, so it ignored the
  manual `v1.1.0` tag and produced `v1.0.2` on the next merge (regressing below
  `v1.1.0` and colliding with upstream's inherited `v1.0.x` tags).
- The erroneous `v1.0.2` release and tag were removed.

## [1.0.0] - 2026-08-05

### Added
- `gh` tool: typed wrapper around the GitHub `gh` CLI with `subcommand` + `args`
  map + `repo` + `jsonFields` + `jq` + `limit` + `timeoutSeconds` +
  `forceDangerous` parameters.
- Prompt guidance injected when a prompt mentions GitHub / PRs / issues / repos /
  releases / workflows / gists.
- Bundled `gh` skill documenting the tool and common `gh` commands.
- Safety guards: refuses `repo delete`, `release delete`, `codespace delete`
  (unrecoverable) unless `forceDangerous: true`; detects "not authenticated" and
  returns actionable `gh auth login` guidance; output truncation.
- Runtime tolerance for two common mis-shaped calls: `args` as a JSON array
  (positional tokens) and `subcommand`/`jsonFields` nested inside `args`. An
  internal `normalizeParams` step at the `buildArgv`/`runGh` seams coerces both
  to the correct argv, and `runGh` normalizes before `assertSafeCommand` so a
  nested dangerous command cannot bypass the guard.
- Single-source content constants (`GH_CALL_EXAMPLE`, `GH_ARGS_DESCRIPTION`,
  `GH_SUBCOMMAND_DESCRIPTION`) wired into the tool description, schema, prompt
  guidelines, `GH_GUIDANCE`, `SKILL.md`, and `README.md`.
- 61 tests — pure helpers (`buildArgv`, `assertSafeCommand`, `formatOutput`)
  tested directly, `runGh` tested via dependency injection at the `GhExec`
  system boundary; content-contract tests for the guidance constants.
- `scripts/link-pi-deps.sh` + `pretest` hook for reproducible test resolution.
- GPL-3.0 license.
