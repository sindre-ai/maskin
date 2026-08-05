// One-shot idempotent catalog seed for real deploys (staging/production).
//
// Wired into `apps/dev/Dockerfile`'s CMD, right after `packages/db/dist/migrate.js`
// and before the server starts, so every deploy reaches the same catalog state
// the local dev server auto-seeds — not just local dev. No-ops once
// catalog_packages has any rows, so it's safe to run on every boot, exactly
// like migrate.js is safe to run on every boot.
//
// Delegates to `seedCatalogPackages` in ../src/lib/dev-bootstrap.ts, the same
// function the dev-server-boot path (`seedCatalogIfEmpty`) calls — so this
// script and local dev never seed different data.
//
// Run manually:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-catalog.ts

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { seedCatalogPackages } from '../src/lib/dev-bootstrap'

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	const db = createDb(url)
	const result = await seedCatalogPackages(db)

	console.log(
		result.seeded
			? `Seeded ${result.packageCount} catalog package(s).`
			: 'Catalog already has packages — no-op.',
	)
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
