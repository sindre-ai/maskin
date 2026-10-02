import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Migration 0083 moves Pro workspaces stuck at the old 2000-cent cap to 4900.
 * Mocked-DB tests can't prove the jsonb guard, so this runs the real file
 * against real Postgres (global-setup has already replayed it once on an empty
 * workspaces table; each test seeds rows and replays it).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runMigration() {
	const content = readFileSync(join(MIGRATIONS_DIR, '0083_pro_hard_cap_4900.sql'), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

async function seed(billing: Record<string, unknown> | null) {
	const ws = await insertWorkspace(db, getTestActorId(), {
		settings: billing === null ? {} : { billing },
	})
	return ws.id
}

async function storedBilling(id: string) {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
	return (row?.settings as { billing?: Record<string, unknown> }).billing
}

describe('migration 0083_pro_hard_cap_4900 (integration)', () => {
	it('moves a Pro row stored at 2000 to 4900 and leaves its other billing fields alone', async () => {
		const id = await seed({
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2000,
			stripe_customer_id: 'cus_x',
			period_end: 1793443941,
		})

		await runMigration()

		expect(await storedBilling(id)).toEqual({
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 4900,
			stripe_customer_id: 'cus_x',
			period_end: 1793443941,
		})
	})

	it('leaves a Team row at 2000 and a trial row at 3000 untouched', async () => {
		const teamId = await seed({ plan: 'team', status: 'active', hard_cap_usd_cents: 2000 })
		const trialId = await seed({ plan: 'trial', status: 'active', hard_cap_usd_cents: 3000 })

		await runMigration()

		expect((await storedBilling(teamId))?.hard_cap_usd_cents).toBe(2000)
		expect((await storedBilling(trialId))?.hard_cap_usd_cents).toBe(3000)
	})

	it('leaves Pro rows with any other cap, a null cap, no billing, or a non-pro plan untouched', async () => {
		const custom = await seed({ plan: 'pro', hard_cap_usd_cents: 3500 })
		const alreadyFixed = await seed({ plan: 'pro', hard_cap_usd_cents: 4900 })
		const nullCap = await seed({ plan: 'pro', hard_cap_usd_cents: null })
		const noBilling = await seed(null)
		const enterprise = await seed({ plan: 'enterprise', hard_cap_usd_cents: 2000 })

		await runMigration()

		expect((await storedBilling(custom))?.hard_cap_usd_cents).toBe(3500)
		expect((await storedBilling(alreadyFixed))?.hard_cap_usd_cents).toBe(4900)
		expect((await storedBilling(nullCap))?.hard_cap_usd_cents).toBeNull()
		expect(await storedBilling(noBilling)).toBeUndefined()
		expect((await storedBilling(enterprise))?.hard_cap_usd_cents).toBe(2000)
	})

	it('is idempotent: a second run changes nothing', async () => {
		const id = await seed({ plan: 'pro', hard_cap_usd_cents: 2000 })

		await runMigration()
		const [first] = await db.select().from(workspaces).where(eq(workspaces.id, id))
		await runMigration()
		const [second] = await db.select().from(workspaces).where(eq(workspaces.id, id))

		expect(
			(second?.settings as { billing: { hard_cap_usd_cents: number } }).billing.hard_cap_usd_cents,
		).toBe(4900)
		expect(second?.updatedAt).toEqual(first?.updatedAt)
	})
})
