import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

/**
 * Subcommand word-pairs that are destructive or open a code-execution / config-
 * tampering path — refused unless forceDangerous is set AND the user confirms
 * via the runtime dialog.
 */
const DANGEROUS_COMMANDS = [
	"repo delete",
	"release delete",
	"codespace delete",
	// Arbitrary code execution / shell access.
	"extension install",
	"extension upgrade",
	"codespace ssh",
	"codespace cp",
	// Command/config tampering.
	"alias set",
	"alias delete",
	"config set",
];

/** gh api HTTP methods that change remote state. */
const DESTRUCTIVE_API_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** gh api flags that imply a POST body (data-carrying requests). */
const API_BODY_FLAGS = new Set(["f", "F", "field", "raw-field", "input"]);

/**
 * Find the first dangerous operation the params would execute, or null when the
 * call is safe. Covers:
 * - destructive gh subcommand pairs (see DANGEROUS_COMMANDS)
 * - `gh api` calls whose effective HTTP method mutates state (POST/PUT/PATCH/DELETE,
 *   explicit via -X/--method, or implied by data flags and `api graphql`)
 */
export function findDangerousOperation(params: GhParams): string | null {
	const words = params.subcommand.trim().toLowerCase().split(/\s+/);
	for (let i = 0; i < words.length - 1; i++) {
		const pair = `${words[i]} ${words[i + 1]}`;
		if (DANGEROUS_COMMANDS.includes(pair)) {
			return pair;
		}
	}

	if (words[0] === "api") {
		const method = detectApiMethod(params);
		if (method !== null && DESTRUCTIVE_API_METHODS.has(method)) {
			return `api ${method}`;
		}
	}

	return null;
}

/**
 * Determine the effective HTTP method of a `gh api` call.
 * Returns "GET" when no mutating signal is present, or the explicit method.
 * `gh api` defaults to POST when body-carrying flags (-f/-F/--input/...) are
 * passed, and `api graphql` always POSTs.
 */
function detectApiMethod(params: GhParams): string {
	// Explicit -X/--method in the subcommand string (e.g. "api -X DELETE repos/x/y").
	const tokens = params.subcommand.trim().split(/\s+/);
	for (let i = 1; i < tokens.length - 1; i++) {
		const t = tokens[i].toLowerCase();
		if (t === "-x" || t === "--method") {
			return tokens[i + 1].toUpperCase();
		}
		if (t.startsWith("--method=")) {
			return t.slice("--method=".length).toUpperCase();
		}
	}

	// Method/body flags from the args map (single value or array form).
	let bodyFlag = false;
	if (params.args && typeof params.args === "object") {
		for (const [key, value] of Object.entries(params.args)) {
			const k = key.toLowerCase().replace(/^-+/, "");
			if (k === "x" || k === "method") {
				if (typeof value === "string") return value.toUpperCase();
				if (Array.isArray(value) && typeof value[0] === "string") return value[0].toUpperCase();
			}
			if (API_BODY_FLAGS.has(k) && value !== false && value !== null && value !== undefined) {
				bodyFlag = true;
			}
		}
	}

	if (tokens[1] && tokens[1].toLowerCase() === "graphql") return "POST";
	if (bodyFlag) return "POST";
	return "GET";
}

/** Regex matching gh's not-authenticated error messages. */
const NOT_AUTHED = /not logged in|authentication required|auth.*fail/i;

/**
 * gh subcommands whose `<verb> view` form does NOT accept --limit
 * (only the list/search forms do). Passing --limit there fails with
 * "unknown flag: --limit", which gives the model nothing to recover with.
 * `codespace view`, `ruleset view`, and `project view` verified against the
 * real gh CLI — they exist and take no --limit.
 */
const NO_LIMIT_SUBCOMMANDS = new Set([
	"pr view",
	"issue view",
	"run view",
	"release view",
	"repo view",
	"gist view",
	"codespace view",
	"workflow view",
	"ruleset view",
	"project view",
]);

/**
 * View pairs whose view form supports `--json` (verified against the real
 * gh binary, v2.100: `gh run view --help` lists `--json fields`; note older
 * gh releases lacked --json on run view). Used to tailor the guard's retry
 * suggestion — suggesting jsonFields to a pair without --json support would
 * just trade one unknown-flag error for another.
 */
const VIEW_PAIRS_WITH_JSON = new Set([
	"pr view",
	"issue view",
	"run view",
	"release view",
	"repo view",
	"codespace view",
]);

export type GhParams = {
	subcommand: string;
	args?: Record<string, string | number | boolean | string[] | null | undefined>;
	repo?: string;
	jsonFields?: string[];
	jq?: string;
	limit?: number;
	timeoutSeconds?: number;
	forceDangerous?: boolean;
};

export type RawGhParams = Omit<GhParams, "subcommand" | "args"> & {
	subcommand?: string;
	args?: GhParams["args"] | string[];
};

/** Flags in array-args that promote to typed top-level fields when unset. */
const PROMOTABLE_FLAGS = new Set(["json", "jq", "repo", "limit"]);

/**
 * Normalize raw tool params into canonical GhParams. Tolerates two mis-shaped
 * calls the model produces: args as a JSON array (mode #1) and known top-level
 * keys nested inside an object args (mode #2). Top-level fields always win.
 */
function normalizeParams(raw: RawGhParams): GhParams {
	const { args: rawArgs, ...rest } = raw;
	const subcommand = rest.subcommand ?? "";

	// Mode #1: args is an array of positional/flag tokens.
	if (Array.isArray(rawArgs)) {
		const parts: string[] = subcommand.trim().split(/\s+/).filter(Boolean);
		const flags: NonNullable<GhParams["args"]> = {};
		let jsonFields = rest.jsonFields;
		let jq = rest.jq;
		let repo = rest.repo;
		let limit = rest.limit;

		for (let i = 0; i < rawArgs.length; i++) {
			const token = rawArgs[i];
			if (token.startsWith("--")) {
				let name: string;
				let value: string | undefined;

				const eq = token.indexOf("=");
				if (eq >= 0) {
					name = token.slice(2, eq);
					value = token.slice(eq + 1);
				} else {
					name = token.slice(2);
					if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) {
						value = rawArgs[++i];
					}
				}

				if (PROMOTABLE_FLAGS.has(name)) {
					if (name === "json" && jsonFields === undefined && value !== undefined) {
						jsonFields = value.split(",");
					} else if (name === "jq" && jq === undefined && value !== undefined) {
						jq = value;
					} else if (name === "repo" && repo === undefined && value !== undefined) {
						repo = value;
					} else if (name === "limit" && limit === undefined && value !== undefined) {
						limit = parseInt(value, 10);
					}
					// If top-level is already set, the parsed duplicate is dropped.
				} else {
					flags[name] = value === undefined ? true : value;
				}
			} else {
				parts.push(token);
			}
		}

		return {
			...rest,
			subcommand: parts.join(" "),
			args: Object.keys(flags).length > 0 ? flags : undefined,
			jsonFields,
			jq,
			repo,
			limit,
		};
	}

	// Object args or no args — harvest known top-level keys from nested args (mode #2).
	if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
		const knownKeys: (keyof RawGhParams)[] = [
			"subcommand", "jsonFields", "jq", "repo", "limit", "timeoutSeconds", "forceDangerous",
		];
		const harvested: Partial<GhParams> = {};
		const remaining: NonNullable<GhParams["args"]> = {};

		for (const [key, value] of Object.entries(rawArgs)) {
			if (knownKeys.includes(key as keyof RawGhParams)) {
				// Top-level wins — only harvest when unset AND the type matches.
				// When top-level is already set, the nested duplicate is dropped entirely.
				// When top-level is unset but the type mismatches, fall through to a flag
				// so a mis-typed knownKey (e.g. {args:{limit:"5"}}) becomes --limit 5
				// instead of being silently dropped.
				if (key === "subcommand") {
					if (!subcommand && typeof value === "string") harvested.subcommand = value;
					else if (!subcommand) remaining[key] = value as string | number | boolean | string[];
				} else if (key === "jsonFields") {
					if (rest.jsonFields === undefined && Array.isArray(value)) harvested.jsonFields = value as string[];
					else if (rest.jsonFields === undefined) remaining[key] = value as string | number | boolean | string[];
				} else if (key === "jq") {
					if (rest.jq === undefined && typeof value === "string") harvested.jq = value;
					else if (rest.jq === undefined) remaining[key] = value as string | number | boolean | string[];
				} else if (key === "repo") {
					if (rest.repo === undefined && typeof value === "string") harvested.repo = value;
					else if (rest.repo === undefined) remaining[key] = value as string | number | boolean | string[];
				} else if (key === "limit") {
					if (rest.limit === undefined && typeof value === "number") harvested.limit = value;
					else if (rest.limit === undefined) remaining[key] = value as string | number | boolean | string[];
				} else if (key === "timeoutSeconds") {
					if (rest.timeoutSeconds === undefined && typeof value === "number") harvested.timeoutSeconds = value;
					else if (rest.timeoutSeconds === undefined) remaining[key] = value as string | number | boolean | string[];
				} else if (key === "forceDangerous") {
					if (rest.forceDangerous === undefined && typeof value === "boolean") harvested.forceDangerous = value;
					else if (rest.forceDangerous === undefined) remaining[key] = value as string | number | boolean | string[];
				}
			} else if (key === "args" && Array.isArray(value)) {
				// Nested args inside args (array form) — recurse via mode #1.
				const inner = normalizeParams({ ...rest, subcommand, args: value });
				if (inner.subcommand && !subcommand) harvested.subcommand = inner.subcommand;
				if (inner.jsonFields !== undefined && rest.jsonFields === undefined) harvested.jsonFields = inner.jsonFields;
				if (inner.jq !== undefined && rest.jq === undefined) harvested.jq = inner.jq;
				if (inner.repo !== undefined && rest.repo === undefined) harvested.repo = inner.repo;
				if (inner.limit !== undefined && rest.limit === undefined) harvested.limit = inner.limit;
				if (inner.args) Object.assign(remaining, inner.args);
			} else if (key === "args" && typeof value === "object" && value !== null && !Array.isArray(value)) {
				// Nested args inside args (object form) — merge remaining flags.
				Object.assign(remaining, value as Record<string, string | number | boolean | string[]>);
			} else {
				remaining[key] = value as string | number | boolean | string[];
			}
		}

		return {
			...rest,
			subcommand: harvested.subcommand ?? subcommand,
			args: Object.keys(remaining).length > 0 ? remaining : undefined,
			jsonFields: harvested.jsonFields ?? rest.jsonFields,
			jq: harvested.jq ?? rest.jq,
			repo: harvested.repo ?? rest.repo,
			limit: harvested.limit ?? rest.limit,
			timeoutSeconds: harvested.timeoutSeconds ?? rest.timeoutSeconds,
			forceDangerous: harvested.forceDangerous ?? rest.forceDangerous,
		};
	}

	return { ...rest, subcommand, args: rawArgs };
}

/**
 * Serialize params into the gh CLI's argv format.
 *
 * The subcommand is split on whitespace (e.g. "repo list" → ["repo", "list"]).
 * Args are serialized as `--flag value` token pairs; booleans become bare
 * `--flag` tokens; arrays become repeated `--flag value` pairs;
 * false/null/undefined are skipped. Keys without a `--` prefix are prefixed.
 * Global flags (--repo, --json, --jq, --limit) are appended after subcommand
 * and args, in that order (--json before --jq).
 */
export function buildArgv(params: RawGhParams): string[] {
	const normalized = normalizeParams(params);
	const trimmed = normalized.subcommand.trim();
	if (trimmed.length === 0) {
		throw new Error("subcommand is required and must not be empty or whitespace");
	}

	const argv: string[] = trimmed.split(/\s+/);
	const args = normalized.args ?? {};
	for (const [key, value] of Object.entries(args)) {
		if (value === false || value === null || value === undefined) continue;
		const flag = key.startsWith("--") ? key : `--${key}`;
		if (value === true) {
			argv.push(flag);
		} else if (Array.isArray(value)) {
			for (const v of value) {
				argv.push(flag, String(v));
			}
		} else {
			argv.push(flag, String(value));
		}
	}

	if (normalized.repo) {
		argv.push("--repo", normalized.repo);
	}
	if (normalized.jsonFields && normalized.jsonFields.length > 0) {
		argv.push("--json", normalized.jsonFields.join(","));
	}
	if (normalized.jq) {
		argv.push("--jq", normalized.jq);
	}
	if (typeof normalized.limit === "number") {
		argv.push("--limit", String(normalized.limit));
	}

	return argv;
}

/**
 * Reject `limit` on gh commands that do not accept it. Only list-style
 * commands take `--limit`; the `view` forms reject it with
 * "unknown flag: --limit". Fail fast with the working form instead.
 *
 * Reads the typed `params.limit` plus a flag-shaped `args.limit` — including
 * `--`-prefixed object keys, which buildArgv passes through verbatim. The
 * normalizer deliberately converts a mis-typed nested `limit` into an args
 * flag, and models echo flag names from error text, so both shapes must be
 * guarded or the raw CLI error leaks through.
 */
export function assertLimitUsage(params: GhParams): void {
	const args = params.args ?? {};
	// Nullish/false args.limit would mask a sibling "--limit" key that the
	// serializer still emits — fall through to the dash-prefixed key.
	const argsLimit =
		args.limit === undefined || args.limit === null || args.limit === false
			? args["--limit"]
			: args.limit;
	// `--limit` (or `--limit=N`) can also be embedded directly in the
	// subcommand string, which the serializer splits verbatim into argv —
	// and as an args-object key with the value inline (`{"--limit=3": true}`),
	// which the serializer passes through verbatim. Scan both the same way.
	const words = params.subcommand.trim().toLowerCase().split(/\s+/);
	const flagLooksLikeLimit = (token: string) =>
		token === "--limit" || token.startsWith("--limit=");
	const subLimit = words.some(flagLooksLikeLimit);
	const argsKeyLimit = Object.entries(args).some(([k, v]) => {
		if (v === false || v === null || v === undefined) return false; // serializer drops these
		return flagLooksLikeLimit(k.startsWith("--") ? k : `--${k}`);
	});
	const limit =
		params.limit ?? (argsLimit as unknown) ?? (subLimit || argsKeyLimit ? "present" : undefined);
	if (limit === undefined || limit === null || limit === false) return;
	for (let i = 0; i < words.length - 1; i++) {
		const pair = `${words[i]} ${words[i + 1]}`;
		if (NO_LIMIT_SUBCOMMANDS.has(pair)) {
			const retryForm = VIEW_PAIRS_WITH_JSON.has(pair)
				? `subcommand: "${pair} <id>" with the fields in jsonFields`
				: `subcommand: "${pair} <id>" (this view form has no --json; read its plain output)`;
			throw new Error(
				`\`${pair}\` does not accept --limit (the CLI rejects it with "unknown flag: --limit") — only list-style commands do. ` +
				`Working form: fetch the item directly, e.g. ${retryForm}; ` +
				`or use the list form (e.g. "${words[i]} list") with limit.`,
		);
		}
	}
}

/**
 * Guard against dangerous gh operations: destructive subcommands, mutating raw
 * API calls, and code-execution paths. Refused unless the caller explicitly sets
 * `forceDangerous: true` — and even then runGh additionally asks the user for
 * confirmation via the runtime dialog before executing.
 */
export function assertSafeCommand(params: GhParams): void {
	const danger = findDangerousOperation(params);
	if (danger === null || params.forceDangerous === true) return;
	throw new Error(
		`Refusing \`${danger}\` from the gh tool — this operation is destructive or enables arbitrary code execution. ` +
			"To override, set `forceDangerous: true` and confirm with the user first.",
	);
}

/**
 * Patterns for credential-shaped strings (gh CLI OAuth/user/server tokens and
 * fine-grained PATs) replaced before tool output enters model context.
 */
const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
	{ pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "gh*_REDACTED" },
	{ pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_REDACTED" },
];

/**
 * Redact credential-shaped strings from gh output so a leaked token (e.g. via
 * `gh auth token` or `gh auth status --show-token`) never reaches model context.
 */
export function redactSecrets(text: string): string {
	let result = text;
	for (const { pattern, replacement } of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

/**
 * Format stdout/stderr into a single human-readable string.
 * If both are empty/whitespace, returns a placeholder.
 */
export function formatOutput(stdout: string, stderr: string): string {
	const chunks: string[] = [];
	if (stdout.trim().length > 0) chunks.push(redactSecrets(stdout.trimEnd()));
	if (stderr.trim().length > 0) chunks.push(`stderr:\n${redactSecrets(stderr.trimEnd())}`);
	return chunks.join("\n\n") || "(no output)";
}

/** Result shape returned by the injected exec boundary (compatible with pi.exec). */
export type ExecResult = { stdout?: string; stderr?: string; code?: number | null; killed?: boolean };

/** System boundary: spawns the gh CLI. Injected for testing. */
export type GhExec = (
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

/** Minimal UI surface used by runGh for enforced dangerous-command confirmation. */
export type ConfirmUI = { confirm(title: string, message: string): Promise<boolean> };

/**
 * Core execution logic, separated from the Pi tool wiring so it can be tested
 * with an injected `exec` (the only system boundary). Returns the same shape
 * as a Pi tool result.
 *
 * `ui` is the runtime confirmation dialog; when provided, dangerous operations
 * require an explicit user confirmation even after `forceDangerous: true` is
 * set — the flag alone no longer bypasses the guard.
 */
export async function runGh(
	rawParams: RawGhParams,
	exec: GhExec,
	signal?: AbortSignal,
	ui?: ConfirmUI,
): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: boolean;
}> {
	// Normalize before guard: the model may nest subcommand inside args,
	// so we must harvest it before assertSafeCommand can see it.
	const params = normalizeParams(rawParams);

	if (!params.subcommand || params.subcommand.trim().length === 0) {
		throw new Error("Pass a gh subcommand, for example `subcommand: 'repo list'` or `subcommand: 'pr list'`.");
	}
	assertSafeCommand(params);
	assertLimitUsage(params);

	// Enforced confirmation: forceDangerous opts in, but the user must also
	// approve via the runtime dialog — the flag alone does not bypass the guard.
	const danger = findDangerousOperation(params);
	if (danger !== null && ui) {
		const confirmed = await ui.confirm(
			"Run dangerous gh command?",
			`The gh tool is about to run \`${danger}\`, which is destructive or enables arbitrary code execution. Approve?`,
		);
		if (!confirmed) {
			throw new Error(`User declined confirmation for \`${danger}\`. The command was not run.`);
		}
	}

	const argv = buildArgv(params);
	const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? 30, 1), 120);

	let result: ExecResult;
	try {
		result = await exec("gh", argv, { signal, timeout: timeoutSeconds * 1000 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to run gh CLI. Is it installed and on PATH? ${message}`);
	}

	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const code = result.code;

	// Detect the common "not authenticated" failure and give actionable guidance.
	if (code !== 0 && (NOT_AUTHED.test(stdout) || NOT_AUTHED.test(stderr))) {
		return {
			content: [
				{
					type: "text",
					text:
						"You are not authenticated with the GitHub CLI. Run `gh auth login` to authenticate, " +
						"then retry the command.",
				},
			],
			details: { subcommand: params.subcommand, code, notAuthed: true },
			isError: true,
		};
	}

	const output = formatOutput(stdout, stderr);
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	const commandLine = `gh ${argv.join(" ")}`;
	const codeText = code === null || code === undefined ? "unknown" : String(code);
	let text = `Command: ${commandLine}\nExit code: ${codeText}${result.killed ? " (killed)" : ""}\n\n${truncation.content}`;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
	}

	return {
		content: [{ type: "text", text }],
		details: {
			subcommand: params.subcommand,
			argv,
			code,
			killed: result.killed,
			truncated: truncation.truncated,
		},
		isError: code !== 0,
	};
}

const baseDir = dirname(fileURLToPath(import.meta.url));
const skillPath = join(baseDir, "skill", "SKILL.md");

const RELEVANT_PROMPT = /\b(github|gh cli|pr |pull request|issue|repo|release|workflow|gist)\b/i;

/** Canonical flat call-shape example — single source of truth for all prompt surfaces. */
export const GH_CALL_EXAMPLE = {
	subcommand: "pr list",
	args: { state: "open" },
	repo: "owner/repo",
	jsonFields: ["number", "title", "state"],
	limit: 10,
} as const;

export const GH_ARGS_DESCRIPTION =
	"Command flags as a key/value object map (e.g. {state: \"open\", web: true}). " +
	"Must be an object, not an array. " +
	"Never put subcommand, jsonFields, repo, jq, or limit inside args — " +
	"those are top-level params, not nested inside args.";

export const GH_SUBCOMMAND_DESCRIPTION =
	"The gh CLI subcommand as a top-level param, e.g. 'repo view owner/repo' or 'pr list'. " +
	"Split on spaces into the command path. " +
	"This is a top-level param — never nest it inside args.";

const GH_CALL_EXAMPLE_JSON = JSON.stringify(GH_CALL_EXAMPLE, null, 2);

/**
 * Guidance injected into the system prompt when the user's message looks
 * GitHub-related. Kept short — the full reference lives in the SKILL.md.
 */
export const GH_GUIDANCE = `## GitHub CLI (gh) guidance

The \`gh\` tool wraps the GitHub CLI (\`gh\`) as a single typed tool. All params are top-level siblings — never nest subcommand, jsonFields, repo, jq, or limit inside args.

Call shape (all params flat at top level):
\`\`\`json
${GH_CALL_EXAMPLE_JSON}
\`\`\`

- \`subcommand\` (top-level): the gh command, e.g. "pr list" or "repo view owner/repo".
- \`args\` (top-level): key/value object map of flags only, e.g. {state: "open", web: true}. Must be an object, not an array.
- \`jsonFields\` (top-level): string array for --json output.
- \`jq\` (top-level): jq filter expression.
- \`repo\` (top-level): target repo as owner/repo.
- \`limit\` (top-level): max results. Only valid on list-style commands (e.g. \`pr list\`); \`view\` commands reject it with "unknown flag: --limit" — the tool refuses it with the working form.

Key patterns:
- List PRs: \`subcommand: "pr list"\`, \`args: { state: "open" }\`, \`limit: 10\`.
- Structured output: \`jsonFields: ["number", "title", "state"]\` → \`--json number,title,state\`. Use \`jq\` to filter/project.
- Target a repo: \`repo: "owner/repo"\` → \`--repo owner/repo\`.
- Destructive ops (\`repo delete\`, \`release delete\`, \`codespace delete\`, mutating \`gh api\` calls, \`extension install/upgrade\`, \`codespace ssh/cp\`, \`alias set/delete\`, \`config set\`) require \`forceDangerous: true\` AND an explicit user confirmation via the runtime dialog — the flag alone is not enough.

If the tool reports you are not authenticated, run \`gh auth login\` via bash.`;

export default function ghExtension(pi: ExtensionAPI) {
	// Make the bundled SKILL.md discoverable as a skill.
	pi.on("resources_discover", () => ({
		skillPaths: [skillPath],
	}));

	// Inject concise guidance when the prompt looks GitHub-related.
	pi.on("before_agent_start", (event) => {
		if (!RELEVANT_PROMPT.test(event.prompt)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${GH_GUIDANCE}\n`,
		};
	});

	pi.registerTool({
		name: "gh",
		label: "GitHub CLI",
		description:
			"Call the GitHub CLI (gh) to interact with repositories, pull requests, issues, releases, workflows, gists, and more. " +
			"All params are top-level siblings: subcommand (e.g. 'pr list'), args (object of flags), jsonFields, jq, repo, limit. " +
			"Never nest subcommand/jsonFields/repo/jq/limit inside args — args is a flat key/value object of flags only.\n" +
			"Example call shape:\n" + GH_CALL_EXAMPLE_JSON + "\n" +
			"Destructive operations (repo delete, release delete, codespace delete, mutating gh api calls, extension install/upgrade, codespace ssh/cp, alias set/delete, config set) require `forceDangerous: true` plus an explicit user confirmation dialog.",
		promptSnippet:
			"Interact with GitHub (repos, PRs, issues, releases, workflows, gists) via the gh CLI.",
		promptGuidelines: [
			"Use the `gh` tool when the user asks about GitHub — repos, PRs, issues, releases, workflows, or gists. It calls the gh CLI directly.",
			"All params are top-level siblings: subcommand, args, jsonFields, jq, repo, limit, forceDangerous. Never nest one inside another.",
			"`args` is a key/value object of flags only (e.g. {state: \"open\", web: true}), never an array, and never contains subcommand/jsonFields/repo/jq/limit.",
			"Use `jsonFields` + `jq` for structured output when you need to parse results programmatically.",
			"Destructive operations (`repo delete`, `release delete`, `codespace delete`, mutating `gh api` calls, `extension install/upgrade`, `codespace ssh/cp`, `alias set/delete`, `config set`) require `forceDangerous: true`. The runtime will additionally ask the user to confirm — always explain what the command does before calling.",
			"If the tool reports you are not authenticated, tell the user to run `gh auth login`.",
		],
		parameters: Type.Object({
			subcommand: Type.Optional(
				Type.String({
					description: GH_SUBCOMMAND_DESCRIPTION,
				}),
			),
			args: Type.Optional(
				Type.Union([
					Type.Record(
						Type.String(),
						Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
					),
					Type.Array(Type.String()),
				], {
					description: GH_ARGS_DESCRIPTION,
				}),
			),
			repo: Type.Optional(
				Type.String({
					description: "Target repository as owner/repo (translates to --repo owner/repo).",
				}),
			),
			jsonFields: Type.Optional(
				Type.Array(
					Type.String(),
					{ description: "GitHub fields to return as JSON (translates to --json field1,field2,...)." },
				),
			),
			jq: Type.Optional(
				Type.String({ description: "jq expression to filter/project JSON output (translates to --jq expr)." }),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, description: "Maximum number of results (translates to --limit N)." }),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 120,
					default: 30,
					description: "Command timeout in seconds (default 30, max 120).",
				}),
			),
			forceDangerous: Type.Optional(
				Type.Boolean({
					description: "Opt-in flag for dangerous commands (repo delete, release delete, codespace delete, mutating gh api calls, extension install/upgrade, codespace ssh/cp, alias set/delete, config set). The user is still asked to confirm via a dialog before execution.",
				}),
			),
		}),
		async execute(_toolCallId, params: RawGhParams, signal, _onUpdate, ctx) {
			return runGh(params, (cmd, args, opts) => pi.exec(cmd, args, opts), signal, ctx?.ui);
		},
	});
}
