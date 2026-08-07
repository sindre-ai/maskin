// Idempotent marketplace sync for real deploys (staging/production).
//
// Wired into `apps/dev/Dockerfile`'s CMD, right after `packages/db/dist/migrate.js`
// and before the server starts, so every deploy reaches the same marketplace state
// the local dev server auto-seeds — not just local dev. Upserts by slug, so
// it's safe to run on every boot: a loop is inserted if missing, updated in
// place if its code-defined version has moved on, or left untouched if the
// version already matches — exactly like migrate.js is safe to run on every boot.
//
// Delegates to `seedMarketplaceLoops` in ../src/lib/dev-bootstrap.ts, the same
// function the dev-server-boot path (`seedMarketplaceIfEmpty`) calls — so this
// script and local dev never seed different data.
//
// Run manually:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-marketplace.ts

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { seedMarketplaceLoops } from '../src/lib/dev-bootstrap'

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	const db = createDb(url)
	const result = await seedMarketplaceLoops(db)

	console.log(
		`Marketplace sync: ${result.inserted.length} inserted, ${result.updated.length} updated, ${result.unchanged.length} unchanged.`,
	)
	if (result.inserted.length > 0) console.log(`  Inserted: ${result.inserted.join(', ')}`)
	if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(', ')}`)
	process.exit(0)
}

// Guard against running when imported by tests. Argv[1] is undefined under
// vitest workers, and truthy under direct `tsx` execution.
const invokedDirectly =
	typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exit(1)
	})
}
