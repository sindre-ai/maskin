// One-shot run of the audit-chain snapshot job and verifier (the daily job in
// src/jobs/keychain-chain-snapshot.ts), for the main-only smoke workflow.
//
// Walks every workspace's credential_access_log chain, checks the latest snapshot in
// credential_chain_snapshots against it, and writes at most one row per workspace for
// today. A second run on the same UTC day writes nothing.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/snapshot-chain.ts
//
// Prints the run result as one JSON line. Exit code 0 = ran clean, 1 = failed (a chain
// or snapshot verification failure, or a database error).

import { createDb } from '@maskin/db'
import { ChainSnapshotJob } from '../src/jobs/keychain-chain-snapshot'

async function main(): Promise<number> {
	const url = process.env.DATABASE_URL
	if (!url) {
		console.error('DATABASE_URL is required')
		return 1
	}
	const db = createDb(url)
	try {
		const result = await new ChainSnapshotJob(db).run()
		console.log(JSON.stringify(result))
		return result.verificationFailures > 0 || result.errors > 0 ? 1 : 0
	} finally {
		await db.$client.end()
	}
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	},
)
