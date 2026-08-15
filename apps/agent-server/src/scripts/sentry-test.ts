// One-off CLI: emits a single test exception through the same Sentry client
// the running agent-server uses. Run with `pnpm --filter @maskin/agent-server sentry-test`.
// SENTRY_DSN_AGENT_SERVER and NODE_ENV=production, or SENTRY_FORCE_ENABLE=true,
// must be set — otherwise the module-level init in `../lib/sentry` no-ops and
// the captureException call goes nowhere, which the exit code and the log
// line below make explicit.
import { Sentry } from '../lib/sentry'

export type SentryTestExit = 0 | 1 | 2 | 3

export async function runSentryTest(
	env: NodeJS.ProcessEnv = process.env,
	stdout: (line: string) => void = (l) => process.stdout.write(l),
	stderr: (line: string) => void = (l) => process.stderr.write(l),
): Promise<SentryTestExit> {
	const dsn = env.SENTRY_DSN_AGENT_SERVER
	const enabled = env.NODE_ENV === 'production' || env.SENTRY_FORCE_ENABLE === 'true'
	if (!dsn || !enabled) {
		stderr(
			'[sentry-test] Sentry is not initialised in this environment ' +
				'(need SENTRY_DSN_AGENT_SERVER set, plus NODE_ENV=production or SENTRY_FORCE_ENABLE=true). ' +
				'Nothing sent.\n',
		)
		return 1
	}

	const error = new Error(
		`Sentry test exception from apps/agent-server (${new Date().toISOString()})`,
	)
	Sentry.captureException(error, { tags: { source: 'sentry-test-script' } })

	// Sentry buffers events — flush before exit or the process dies mid-send.
	const flushed = await Sentry.flush(5000)
	if (!flushed) {
		stderr('[sentry-test] Sentry.flush timed out — event may not have been sent\n')
		return 2
	}
	stdout('[sentry-test] event captured and flushed\n')
	return 0
}

// Only run when invoked directly (not when imported by tests). The Node ESM
// idiom `import.meta.url === pathToFileURL(process.argv[1]).href` is the
// bundle-safe equivalent of `require.main === module`.
const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isDirect) {
	runSentryTest().then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`[sentry-test] unexpected failure: ${String(err)}\n`)
			process.exit(3)
		},
	)
}
