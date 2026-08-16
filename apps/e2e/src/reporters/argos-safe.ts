import ArgosReporter from '@argos-ci/playwright/reporter'
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestError,
	TestResult,
	TestStep,
} from '@playwright/test/reporter'

// Argos uploads happen in the reporter's onEnd hook. When the service rejects
// the upload (quota exhausted, transient outage, auth), a raw throw here fails
// the whole Playwright run — even when every functional test passed — which
// blocks every PR merge until a human intervenes. Argos surfaces the actual
// visual-regression verdict through its own GitHub check on the PR, so the
// Playwright run's pass/fail should not depend on the upload succeeding.

type ReporterCtor = new (options?: unknown) => Reporter

export default class ArgosSafeReporter implements Reporter {
	private readonly inner: Reporter

	constructor(options?: unknown) {
		this.inner = new (ArgosReporter as unknown as ReporterCtor)(options)
	}

	onBegin(config: FullConfig, suite: Suite): void {
		try {
			this.inner.onBegin?.(config, suite)
		} catch (err) {
			warn('onBegin', err)
		}
	}

	onTestBegin(test: TestCase, result: TestResult): void {
		try {
			this.inner.onTestBegin?.(test, result)
		} catch (err) {
			warn('onTestBegin', err)
		}
	}

	onStepBegin(test: TestCase, result: TestResult, step: TestStep): void {
		try {
			this.inner.onStepBegin?.(test, result, step)
		} catch (err) {
			warn('onStepBegin', err)
		}
	}

	onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
		try {
			this.inner.onStepEnd?.(test, result, step)
		} catch (err) {
			warn('onStepEnd', err)
		}
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		try {
			this.inner.onTestEnd?.(test, result)
		} catch (err) {
			warn('onTestEnd', err)
		}
	}

	onError(error: TestError): void {
		try {
			this.inner.onError?.(error)
		} catch (err) {
			warn('onError', err)
		}
	}

	onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
		try {
			this.inner.onStdOut?.(chunk, test, result)
		} catch (err) {
			warn('onStdOut', err)
		}
	}

	onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
		try {
			this.inner.onStdErr?.(chunk, test, result)
		} catch (err) {
			warn('onStdErr', err)
		}
	}

	async onEnd(result: FullResult): Promise<void> {
		try {
			await this.inner.onEnd?.(result)
		} catch (err) {
			warn('onEnd (screenshot upload)', err)
		}
	}

	printsToStdio(): boolean {
		return this.inner.printsToStdio?.() ?? false
	}
}

function warn(phase: string, err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err)
	console.warn(`[argos-safe] ${phase} failed non-fatally: ${msg}`)
}
