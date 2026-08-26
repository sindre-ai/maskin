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

/**
 * Resolve the identity of this build.
 *
 * Called with NO argument in production: commit and version then come only
 * from the compile-time constants above, never from the ambient environment.
 * That is deliberate — a stale `MASKIN_COMMIT_SHA` left behind in the box's
 * .env must not be able to override the SHA that was actually compiled in.
 * The whole point of the metric is that its labels cannot lie; a runtime
 * override reintroduces exactly the failure it exists to detect, silently and
 * permanently.
 *
 * Called WITH a `source` (tests), that object is the complete truth for commit
 * and version: an absent key means absent, regardless of what happens to be
 * exported in the real environment. Without this, `resolveBuildInfo({})` —
 * which reads as "no build metadata" — would still pick up an ambient
 * MASKIN_COMMIT_SHA, and CI exporting one (it is in turbo.json
 * globalPassThroughEnv) would fail the fallback tests for no real reason.
 *
 * `instance` and `env` are ordinary deployment config, not build identity, so
 * they are read from `source ?? process.env` in both cases.
 */
export function resolveBuildInfo(source?: NodeJS.ProcessEnv): BuildInfo {
	const env = source ?? process.env
	return {
		commit: coalesce(source ? source.MASKIN_COMMIT_SHA : BUNDLED_COMMIT, UNKNOWN),
		version: coalesce(source ? source.MASKIN_BUILD_VERSION : BUNDLED_VERSION, UNKNOWN),
		// Defaults mirror `coalesce(sys.env("AGENT_SERVER_INSTANCE"),
		// constants.hostname)` and `coalesce(sys.env("DEPLOY_ENV"), "production")`
		// in observability/alloy.alloy. If these two ever disagree,
		// {instance="finland-1"} stops selecting the same host in logs and
		// metrics, which is the entire point of the label.
		instance: coalesce(env.AGENT_SERVER_INSTANCE, hostname()),
		env: coalesce(env.DEPLOY_ENV, 'production'),
	}
}
