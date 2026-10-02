import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Migration 0083 corrects Pro workspaces whose stored
 * settings.billing.hard_cap_usd_cents was written as 2000 while the prod env
 * still held the old $20 cap. global-setup has already replayed it on an empty
 * schema, so each test seeds stale rows and re-runs the SQL file by hand, which
 * also proves it is idempotent.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_FILE = '0083_pro_cap_2000_to_4900.sql'
const DOWN_FILE = join('down', '0083_pro_cap_2000_to_4900_down.sql')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(MIGRATIONS_DIR, relativePath), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

async function seed(billing?: Record<string, unknown>) {
	const ws = await insertWorkspace(db, getTestActorId(), {
		settings: billing ? { billing } : {},
	})
	return ws.id
}

async function readSettings(id: string) {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
	return row.settings as { billing?: Record<string, unknown> }
}

describe('migration 0083_pro_cap_2000_to_4900 (integration)', () => {
	it('moves a Pro workspace stored at 2000 to 4900 and keeps the rest of billing', async () => {
		const id = await seed({
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2000,
			stripe_subscription_id: 'sub_x',
			period_end: 1_702_592_000,
		})

		await runSqlFile(MIGRATION_FILE)

		expect((await readSettings(id)).billing).toEqual({
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 4900,
			stripe_subscription_id: 'sub_x',
			period_end: 1_702_592_000,
		})
	})

	it('leaves every other row alone', async () => {
		const proOther = await seed({ plan: 'pro', status: 'active', hard_cap_usd_cents: 3000 })
		const proAlready = await seed({ plan: 'pro', status: 'active', hard_cap_usd_cents: 4900 })
		const proNoCap = await seed({ plan: 'pro', status: 'active' })
		const teamStale = await seed({ plan: 'team', status: 'active', hard_cap_usd_cents: 2000 })
		const trialStale = await seed({ plan: 'trial', hard_cap_usd_cents: 2000 })
		const noBilling = await seed()

		await runSqlFile(MIGRATION_FILE)

		expect((await readSettings(proOther)).billing?.hard_cap_usd_cents).toBe(3000)
		expect((await readSettings(proAlready)).billing?.hard_cap_usd_cents).toBe(4900)
		expect((await readSettings(proNoCap)).billing).toEqual({ plan: 'pro', status: 'active' })
		expect((await readSettings(teamStale)).billing?.hard_cap_usd_cents).toBe(2000)
		expect((await readSettings(trialStale)).billing?.hard_cap_usd_cents).toBe(2000)
		expect((await readSettings(noBilling)).billing).toBeUndefined()
	})

	it('is idempotent: a second run changes nothing', async () => {
		const id = await seed({ plan: 'pro', status: 'active', hard_cap_usd_cents: 2000 })

		await runSqlFile(MIGRATION_FILE)
		const first = await readSettings(id)
		await runSqlFile(MIGRATION_FILE)

		expect(await readSettings(id)).toEqual(first)
		expect(first.billing?.hard_cap_usd_cents).toBe(4900)
	})

	it('down migration is a no-op that never lowers a Pro cap', async () => {
		const id = await seed({ plan: 'pro', status: 'active', hard_cap_usd_cents: 4900 })

		await runSqlFile(DOWN_FILE)

		expect((await readSettings(id)).billing?.hard_cap_usd_cents).toBe(4900)
	})
})
