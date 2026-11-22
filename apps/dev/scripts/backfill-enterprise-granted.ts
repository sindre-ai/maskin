// Set enterprise_granted on every workspace whose billing owner is on the ops allowlist
// (MASKIN_ENTERPRISE_ACTOR_IDS). Run this BEFORE deploying the change that makes enterprise
// depend on the workspace flag alone: until then those workspaces are enterprise only through
// their owner, and would drop to trial the moment the check changes.
// Safe to re-run: a workspace whose flag is already set is left alone, so a second run changes
// nothing and prints an empty list.
//
// Run:
//   DATABASE_URL=... MASKIN_ENTERPRISE_ACTOR_IDS=... \
//     pnpm --filter @maskin/dev exec tsx scripts/backfill-enterprise-granted.ts [--dry-run]
//
// --dry-run prints the workspaces that would change and writes nothing.
// Prints every workspace it changed (id, name), so run it with --dry-run first for the "before"
// list and keep the real run's output as the "after" list.

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { parseEnterpriseActorIds } from '../src/lib/enterprise'

export async function backfillEnterpriseGranted(
	db: Database,
	options: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ id: string; name: string }[]> {
	const ownerIds = [...parseEnterpriseActorIds(options.env)]
	if (ownerIds.length === 0) {
		throw new Error('MASKIN_ENTERPRISE_ACTOR_IDS is empty, so there is nobody to backfill for')
	}
	const needsFlag = and(
		inArray(workspaces.billingOwnerId, ownerIds),
		eq(workspaces.enterpriseGranted, false),
	)
	if (options.dryRun) {
		return db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(needsFlag)
	}
	return db
		.update(workspaces)
		.set({ enterpriseGranted: true })
		.where(needsFlag)
		.returning({ id: workspaces.id, name: workspaces.name })
}

async function main() {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is required')
	const dryRun = process.argv.slice(2).includes('--dry-run')
	const db = createDb(url)
	try {
		const changed = await backfillEnterpriseGranted(db, { dryRun })
		console.log(
			`${dryRun ? '[dry run] ' : ''}${changed.length} workspaces ${dryRun ? 'to change' : 'changed'}`,
		)
		for (const ws of changed) console.log(`${ws.id}\t${ws.name}`)
	} finally {
		await db.$client.end()
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
