import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestError,
	TestResult,
} from '@playwright/test/reporter'
import ArgosReporterImport from '@argos-ci/playwright/reporter'

// Argos v3's `/reporter` subpath ships the reporter as an ESM default export in
// some builds and a CJS module.exports in others. Normalise both shapes into a
// constructable class so this wrapper works regardless of how the consumer's
// bundler resolves it.
const ArgosReporterCtor = ((
	ArgosReporterImport as unknown as { default?: unknown }
).default ?? ArgosReporterImport) as new (options?: unknown) => Reporter

// Argos surfaces plan/quota exhaustion as an APIError whose message names the
// capacity ceiling. Match on the visible text rather than the class so the
// filter still fires if the SDK renames the error type.
const QUOTA_ERROR_PATTERN =
	/maximum screenshot capacity|screenshot quota|monthly quota|Free Plan|payment required|402/i

function isQuotaError(err: unknown): boolean {
	if (!err) return false
	const message = err instanceof Error ? err.message : String(err)
	return QUOTA_ERROR_PATTERN.test(message)
}

export default class ArgosSoftReporter implements Reporter {
	private readonly inner: Reporter

	constructor(options?: unknown) {
		this.inner = new ArgosReporterCtor(options)
	}

	printsToStdio(): boolean {
		return this.inner.printsToStdio?.() ?? true
	}

	onBegin(config: FullConfig, suite: Suite): void {
		this.inner.onBegin?.(config, suite)
	}

	onTestBegin(test: TestCase, result: TestResult): void {
		this.inner.onTestBegin?.(test, result)
	}

	onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
		this.inner.onStdOut?.(chunk, test, result)
	}

	onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
		this.inner.onStdErr?.(chunk, test, result)
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		this.inner.onTestEnd?.(test, result)
	}

	onError(error: TestError): void {
		this.inner.onError?.(error)
	}

	async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
		try {
			return await this.inner.onEnd?.(result)
		} catch (err) {
			if (isQuotaError(err)) {
				const message = err instanceof Error ? err.message : String(err)
				console.warn(
					`[argos-soft] Skipping Argos upload — quota exhausted; CI status will reflect Playwright results only. Details: ${message}`,
				)
				return
			}
			throw err
		}
	}

	async onExit(): Promise<void> {
		await this.inner.onExit?.()
	}
}
