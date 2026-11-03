import ArgosReporter, { type ArgosReporterOptions } from '@argos-ci/playwright/reporter'
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestResult,
} from '@playwright/test/reporter'

// Argos's upload pipeline (@argos-ci/core's `upload()`) can reject via a
// promise that isn't part of the chain awaited by ArgosReporter.onEnd() —
// observed in CI as an uncaught `APIError: You have reached the maximum
// screenshot capacity included in your Free Plan` that bypasses this file's
// own try/catch entirely (its log line below never appears) and crashes the
// whole process, since Node terminates on any unhandled rejection by
// default. Registering a listener disables that default-crash behavior, so
// this narrowly swallows only Argos-originated rejections and preserves
// normal crash-on-unhandled-rejection behavior for anything else.
//
// Detection relies on the stack containing the package path (`@argos-ci/api-client`'s
// `throwAPIError()` constructs the error, so its frame is always present) plus a
// specific, verbatim phrase from the real observed message as a fallback for cases
// where the stack is unavailable (e.g. a rejection value that isn't a real Error).
// Note: @argos-ci/api-client's `APIError` class never sets `this.name` (it just calls
// `super(message)`), so `reason.name` is always the generic `'Error'` — matching on
// `.name` can't distinguish it from any other error and was removed.
const ARGOS_MESSAGE_MARKERS = [
	'screenshot capacity included in your Free Plan',
	'Argos repository token',
]
function isArgosError(reason: unknown): boolean {
	if (!(reason instanceof Error)) return false
	const message = reason.message ?? ''
	const stack = reason.stack ?? ''
	return (
		stack.includes('@argos-ci') || ARGOS_MESSAGE_MARKERS.some((marker) => message.includes(marker))
	)
}
process.on('unhandledRejection', (reason) => {
	if (isArgosError(reason)) {
		console.error(
			'[argos] unhandled rejection from Argos upload, continuing without upload:',
			reason,
		)
		return
	}
	console.error('Unhandled promise rejection:', reason)
	process.exitCode = 1
})

// Belt-and-suspenders for the same class of bug: if the orphaned promise
// surfaces as an uncaughtException instead of an unhandledRejection (the two
// are easy to conflate when reasoning about a bundled, minified dependency),
// apply the identical Argos-only filter so this can't reintroduce the crash
// under a different Node event name.
process.on('uncaughtException', (error) => {
	if (isArgosError(error)) {
		console.error('[argos] uncaught exception from Argos upload, continuing without upload:', error)
		return
	}
	console.error('Uncaught exception:', error)
	process.exitCode = 1
})

/**
 * Wraps the Argos reporter so an upload failure (free-plan screenshot quota,
 * outage, auth) can't fail the whole Playwright run. Argos's own onEnd()
 * already catches upload errors and logs them, but it then deliberately
 * returns `{ status: 'failed' }` — Playwright's reporter API treats that as
 * a signal to fail the overall run regardless of individual test results.
 * We discard onEnd()'s return value (and belt-and-suspenders catch any
 * throw) so an Argos-side problem never overrides real test outcomes.
 */
export default class SafeArgosReporter implements Reporter {
	private readonly inner: ArgosReporter

	constructor(options: ArgosReporterOptions) {
		this.inner = new ArgosReporter(options ?? {})
	}

	onBegin(config: FullConfig, suite: Suite) {
		this.inner.onBegin(config, suite)
	}

	async onTestEnd(test: TestCase, result: TestResult) {
		try {
			await this.inner.onTestEnd(test, result)
		} catch (error) {
			console.error('[argos] onTestEnd failed, continuing without Argos upload:', error)
		}
	}

	async onEnd(result: FullResult) {
		try {
			await this.inner.onEnd(result)
		} catch (error) {
			console.error('[argos] upload failed, continuing without Argos upload:', error)
		}
		// Belt-and-suspenders beyond the try/catch above and the process-level
		// handlers up top: @argos-ci/core's upload() has been observed to reject
		// via a promise that isn't part of the chain awaited by
		// ArgosReporter.onEnd() (see the file-level comment), so the rejection
		// can surface after this function has already returned normally —
		// too late for either guard to intercept it. Pinning the exit code to
		// Playwright's own verdict here means a late/stray Argos rejection can
		// no longer flip a shard that actually passed into a CI failure, no
		// matter which async path it takes.
		process.exitCode = result.status === 'passed' ? 0 : 1
	}
}
