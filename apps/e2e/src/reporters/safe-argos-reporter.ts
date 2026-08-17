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
// this narrowly swallows only Argos-originated rejections (identified by
// their stack referencing the @argos-ci packages) and preserves normal
// crash-on-unhandled-rejection behavior for anything else.
const isArgosError = (reason: unknown): boolean =>
	reason instanceof Error && (reason.stack?.includes('@argos-ci') ?? false)

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

process.on('uncaughtException', (error) => {
	if (isArgosError(error)) {
		console.error('[argos] uncaught exception from Argos upload, continuing without upload:', error)
		return
	}
	console.error('Uncaught exception:', error)
	process.exit(1)
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
	}
}
