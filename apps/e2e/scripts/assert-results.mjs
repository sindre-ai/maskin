#!/usr/bin/env node
// Playwright's own JSON reporter (playwright.config.ts) is a crash-proof
// source of truth for pass/fail — it's written to disk before
// SafeArgosReporter's onEnd runs, so it reflects real test outcomes
// regardless of what happens downstream in the Argos reporter (an
// exhausted screenshot quota, an outage, or any other upload failure).
// CI runs this instead of trusting the shell's raw exit code, which a
// reporter-side problem unrelated to the tests themselves can still flip
// to non-zero.
import { existsSync, readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path || !existsSync(path)) {
	console.error(
		`[assert-results] no JSON report at ${path ?? '(missing arg)'} — treating as a real failure`,
	)
	process.exit(1)
}

const report = JSON.parse(readFileSync(path, 'utf8'))
const { expected, unexpected, flaky, skipped } = report.stats
console.log(
	`[assert-results] expected=${expected} unexpected=${unexpected} flaky=${flaky} skipped=${skipped}`,
)

// Global errors (webServer failed to start, a config crash, etc.) don't show
// up in stats.unexpected — no test ever ran to fail. Catch those separately
// so an infra-level failure can't read as "0 unexpected" and pass silently.
if (report.errors?.length > 0) {
	console.error(`[assert-results] ${report.errors.length} global error(s) reported by Playwright:`)
	for (const error of report.errors) console.error(error.message ?? error)
	process.exit(1)
}

if (unexpected > 0) {
	console.error(`[assert-results] ${unexpected} test(s) genuinely failed`)
	process.exit(1)
}

console.log(
	'[assert-results] all real tests passed — ignoring any non-test-related process exit code (e.g. Argos)',
)
