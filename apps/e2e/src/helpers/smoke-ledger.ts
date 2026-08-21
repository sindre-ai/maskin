import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getSmokeConfig } from './smoke-env'

// Playwright runs specs in worker processes but `globalTeardown` in the runner
// process, so an in-memory set cannot be shared between them. The ledger is a
// newline-delimited file under `test-results/` (already gitignored) that every
// worker appends to and teardown reads back.
//
// NOTE: deliberately derived from `process.cwd()` and not `import.meta.url` —
// Playwright transpiles these modules to CJS, where `import.meta` throws
// "exports is not defined in ES module scope" and takes down module loading for
// the entire suite. `globalSetup` pins the resolved path into the environment,
// which worker processes inherit, so every process agrees on one ledger file.
const LEDGER_PATH_ENV = 'SMOKE_LEDGER_PATH'

export function resolveLedgerPath(): string {
	return (
		process.env[LEDGER_PATH_ENV] ??
		resolve(process.cwd(), join('test-results', 'smoke-created-objects.log'))
	)
}

/** Pin the ledger location so runner and workers cannot disagree about it. */
export function pinLedgerPath() {
	process.env[LEDGER_PATH_ENV] = resolveLedgerPath()
}

/**
 * Record an object this run created so teardown can delete exactly it, rather
 * than clearing the whole workspace. Safe to call unconditionally — it no-ops
 * outside smoke mode, so local and CI runs never touch the filesystem.
 */
export function recordCreatedObject(id: string | undefined | null) {
	if (!id || !getSmokeConfig()) return
	const path = resolveLedgerPath()
	try {
		mkdirSync(dirname(path), { recursive: true })
		// Single short append per object: concurrent workers interleave lines
		// rather than corrupting each other.
		appendFileSync(path, `${id}\n`, 'utf8')
	} catch (err) {
		// Losing a ledger entry leaks one object; failing the test would be worse.
		console.warn('[smoke-ledger] could not record created object:', err)
	}
}

/** Every object id recorded this run, de-duplicated. */
export function readCreatedObjects(): string[] {
	try {
		const raw = readFileSync(resolveLedgerPath(), 'utf8')
		return [
			...new Set(
				raw
					.split('\n')
					.map((line) => line.trim())
					.filter(Boolean),
			),
		]
	} catch {
		// No ledger means nothing was created.
		return []
	}
}

/** Drop any ledger left over from a previous run on this machine. */
export function clearLedger() {
	try {
		rmSync(resolveLedgerPath(), { force: true })
	} catch (err) {
		console.warn('[smoke-ledger] could not clear ledger:', err)
	}
}
