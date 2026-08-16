import ArgosReporter, { type ArgosReporterOptions } from '@argos-ci/playwright/reporter'
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestResult,
} from '@playwright/test/reporter'

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
