import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Migration 0084 corrects the stored hard cap on Pro workspaces that a stale
 * prod env pinned at 2000 cents ($20) instead of 4900 ($49). It is a data
 * migration with a guard instead of an id list, so the tests pin both what it
 * changes and what it must leave alone.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_FILE = '0084_pro_stored_cap_4900.sql'
const DOWN_FILE = join('down', '0084_pro_stored_cap_4900_down.sql')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(MIGRATIONS_DIR, relativePath), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

async function billingOf(id: string) {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
	return (row.settings as { billing?: Record<string, unknown> }).billing
}

describe('migration 0084_pro_stored_cap_4900 (integration)', () => {
	let actorId: string

	const makeWorkspace = async (billing: Record<string, unknown> | null, extra = {}) => {
		const settings = billing ? { billing, ...extra } : { ...extra }
		return insertWorkspace(db, actorId, { settings })
	}

	beforeEach(() => {
		actorId = getTestActorId()
	})

	it('moves a Pro workspace stored at 2000 to 4900 and keeps the rest of its settings', async () => {
		const ws = await makeWorkspace(
			{ plan: 'pro', status: 'active', hard_cap_usd_cents: 2000, stripe_customer_id: 'cus_1' },
			{ theme: 'dark' },
		)
		await runSqlFile(MIGRATION_FILE)

		expect(await billingOf(ws.id)).toEqual({
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 4900,
			stripe_customer_id: 'cus_1',
		})
		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id))
		expect((row.settings as { theme?: string }).theme).toBe('dark')
	})

	it('leaves Team at 2000, trial at 3000, Pro at other caps and workspaces with no billing untouched', async () => {
		const team = await makeWorkspace({ plan: 'team', hard_cap_usd_cents: 2000 })
		const trial = await makeWorkspace({ plan: 'trial', hard_cap_usd_cents: 3000 })
		const trialAt2000 = await makeWorkspace({ plan: 'trial', hard_cap_usd_cents: 2000 })
		const proCustom = await makeWorkspace({ plan: 'pro', hard_cap_usd_cents: 3000 })
		const proUnset = await makeWorkspace({ plan: 'pro' })
		const noBilling = await makeWorkspace(null)
		await runSqlFile(MIGRATION_FILE)

		expect((await billingOf(team.id))?.hard_cap_usd_cents).toBe(2000)
		expect((await billingOf(trial.id))?.hard_cap_usd_cents).toBe(3000)
		expect((await billingOf(trialAt2000.id))?.hard_cap_usd_cents).toBe(2000)
		expect((await billingOf(proCustom.id))?.hard_cap_usd_cents).toBe(3000)
		expect((await billingOf(proUnset.id))?.hard_cap_usd_cents).toBeUndefined()
		expect(await billingOf(noBilling.id)).toBeUndefined()
	})

	it('is idempotent', async () => {
		const ws = await makeWorkspace({ plan: 'pro', hard_cap_usd_cents: 2000 })
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(MIGRATION_FILE)
		expect((await billingOf(ws.id))?.hard_cap_usd_cents).toBe(4900)
	})

	it('is reversible: the down file puts Pro rows at 4900 back to 2000', async () => {
		const ws = await makeWorkspace({ plan: 'pro', hard_cap_usd_cents: 2000 })
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(DOWN_FILE)
		expect((await billingOf(ws.id))?.hard_cap_usd_cents).toBe(2000)
	})
})
