import { resolveSmokeAccount } from './smoke'
import { getSmokeConfig } from './smoke-env'
import { clearLedger, pinLedgerPath, readCreatedObjects } from './smoke-ledger'

/**
 * Runs before the suite. Drops any ledger left over on this machine so the
 * teardown sweep only ever considers objects created by *this* run.
 */
export async function smokeGlobalSetup() {
	if (!getSmokeConfig()) return
	// Pinned before any worker spawns, so workers inherit the same ledger path.
	pinLedgerPath()
	clearLedger()
}

/**
 * Runs after the suite. Deletes exactly the objects this run created — tracked
 * by id in the ledger — rather than clearing the smoke workspace wholesale.
 * Anything the tenant already held is left untouched.
 */
export async function smokeGlobalTeardown() {
	const config = getSmokeConfig()
	if (!config) return

	const ids = readCreatedObjects()
	if (ids.length === 0) {
		console.log('[smoke-cleanup] nothing to clean up')
		return
	}

	try {
		const { api } = await resolveSmokeAccount(config)
		let deleted = 0
		let alreadyGone = 0

		for (const id of ids) {
			try {
				await api.deleteObject(id, config.workspaceId)
				deleted++
			} catch (err) {
				// A spec that deletes its own object (objects-crud does) leaves a
				// ledger entry pointing at a row that is already gone — expected.
				if (err instanceof Error && /\b404\b/.test(err.message)) {
					alreadyGone++
					continue
				}
				// One undeletable object must not abandon the rest of the sweep.
				console.warn(`[smoke-cleanup] could not delete ${id}:`, err)
			}
		}

		console.log(
			`[smoke-cleanup] deleted ${deleted}/${ids.length} object(s) (${alreadyGone} already gone)`,
		)
		if (deleted + alreadyGone === ids.length) clearLedger()
	} catch (err) {
		// A failed sweep must not fail the canary — the run's verdict on whether
		// production is healthy is what matters here.
		console.warn('[smoke-cleanup] post-run sweep failed:', err)
	}
}
