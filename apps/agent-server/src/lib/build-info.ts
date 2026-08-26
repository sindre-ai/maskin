import { hostname } from 'node:os'

/**
 * Identity of the running binary — "what commit is this, on which box".
 *
 * The commit and version are COMPILE-TIME constants: build.mjs passes them to
 * esbuild's `define`, which textually replaces the two `process.env` reads
 * below with string literals before bundling. Nothing here touches the
 * filesystem.
 *
 * That is deliberate and non-negotiable. The obvious alternative — reading
 * `.git/HEAD` relative to `import.meta.url` — is broken by the very build that
 * ships this file: build.mjs bundles everything into a single flat
 * `dist/index.js`, so `import.meta.url` resolves to the bundle, not to this
 * source file, and the path walks off into a directory that does not exist. It
 * works perfectly under `tsx` and crashes on every production boot. See
 * "Runtime File Reads Relative to `import.meta.url`" in
 * `.claude/rules/known-pitfalls.md` — that exact pattern already took prod down
 * once.
 *
 * Using `process.env.*` as the define target rather than a bare global
 * (`__COMMIT__`) is what keeps the unbundled path working: under `tsx` and
 * under Vitest no substitution happens, the read is an ordinary env lookup, and
 * an unset var falls back to UNKNOWN instead of throwing ReferenceError on an
 * undeclared identifier.
 */
export const UNKNOWN = 'unknown'

// These two reads MUST stay written as the literal expression
// `process.env.<NAME>` — that exact text is the substitution key in build.mjs's
// `define` map. Reading them through a variable (e.g. a `source` parameter)
// hides them from esbuild and silently ships commit="unknown": the build
// succeeds, the endpoint serves, and the one label the whole feature exists for
// is empty.
const BUNDLED_COMMIT = process.env.MASKIN_COMMIT_SHA
const BUNDLED_VERSION = process.env.MASKIN_BUILD_VERSION

export type BuildInfo = {
	/** Full 40-char git SHA of the build, or 'unknown'. */
	commit: string
	/** package.json version of @maskin/agent-server, or 'unknown'. */
	version: string
	/** Host identity. MUST match the `instance` label Alloy applies. */
	instance: string
	/** Deployment environment. MUST match Alloy's `env` label. */
	env: string
}

/** Empty string and whitespace are as absent as undefined. */
function coalesce(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim()
	return trimmed ? trimmed : fallback
}

export function resolveBuildInfo(source: NodeJS.ProcessEnv = process.env): BuildInfo {
	return {
		// `source` first so a test (or an operator debugging a box) can override;
		// the bundled constant is the value that actually ships.
		commit: coalesce(source.MASKIN_COMMIT_SHA ?? BUNDLED_COMMIT, UNKNOWN),
		version: coalesce(source.MASKIN_BUILD_VERSION ?? BUNDLED_VERSION, UNKNOWN),
		// Defaults mirror `coalesce(sys.env("AGENT_SERVER_INSTANCE"),
		// constants.hostname)` and `coalesce(sys.env("DEPLOY_ENV"), "production")`
		// in observability/alloy.alloy. If these two ever disagree,
		// {instance="finland-1"} stops selecting the same host in logs and
		// metrics, which is the entire point of the label.
		instance: coalesce(source.AGENT_SERVER_INSTANCE, hostname()),
		env: coalesce(source.DEPLOY_ENV, 'production'),
	}
}
