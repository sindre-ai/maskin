import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { version } = require('./package.json')

/**
 * Resolve the commit this bundle is built from, at BUILD time.
 *
 * The result is injected below as a compile-time constant, replacing the
 * `process.env.MASKIN_COMMIT_SHA` read in src/lib/build-info.ts with a string
 * literal. Nothing is read from disk at runtime — see the long comment in that
 * file for why the `.git/HEAD`-relative-to-`import.meta.url` alternative is
 * forbidden here (it works under tsx and crashes every production boot).
 *
 * Precedence:
 *   1. MASKIN_COMMIT_SHA — explicit override, and what CI sets
 *      (GITHUB_SHA in Actions) when the checkout may be shallow or detached.
 *   2. `git rev-parse HEAD` — the real deploy path. agent-server-deploy.yml
 *      does `git reset --hard origin/main` and then builds ON the box, inside
 *      the work tree, so HEAD here is exactly the deployed commit.
 *   3. 'unknown' — no git, no override (a tarball build, a Docker layer with
 *      no .git). Deliberately NOT an error: an unidentifiable build must still
 *      build and boot. It shows up as commit="unknown" in Grafana, which is
 *      itself the useful signal.
 */
function resolveCommitSha() {
	const override = (process.env.MASKIN_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '').trim()
	if (override) return override
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
	} catch {
		return 'unknown'
	}
}

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/index.js',
	sourcemap: true,
	// Substituted textually before bundling. Keys must be the exact expressions
	// read in src/lib/build-info.ts; JSON.stringify supplies the quoting.
	define: {
		'process.env.MASKIN_COMMIT_SHA': JSON.stringify(resolveCommitSha()),
		'process.env.MASKIN_BUILD_VERSION': JSON.stringify(version),
	},
	banner: {
		js: "import { createRequire as __createBannerRequire } from 'module'; const require = __createBannerRequire(import.meta.url);",
	},
})
