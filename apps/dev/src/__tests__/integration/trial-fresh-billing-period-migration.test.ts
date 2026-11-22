import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaces } from '@maskin/db/schema'
import { eq, inArray, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Migration 0153 gives running trial workspaces a fresh billing period start. It is run here on
// seeded rows, inside a transaction that is rolled back so it cannot touch other tests' rows.
const migration = readFileSync(
	join(__dirname, '../../../../../packages/db/drizzle/0153_trial_fresh_billing_period.sql'),
	'utf-8',
)

const DAY_MS = 24 * 60 * 60 * 1000
// The factory defaults enterpriseGranted to true; the rule needs it off.
const NOT_ENTERPRISE = { enterpriseGranted: false }

describe('the 0153 trial fresh billing period backfill', () => {
	it('starts a period for qualifying trials only, keeps other settings, and is safe to run twice', async () => {
		const actorId = getTestActorId()
		const recent = { createdAt: new Date(Date.now() - 2 * DAY_MS) }
		const stale = { createdAt: new Date(Date.now() - 40 * DAY_MS) }
		const existingBilling = {
			plan: 'starter',
			status: 'active',
			period_start: 1_700_000_000,
			hard_cap_usd_cents: 1500,
		}

		// Qualifies: no billing block at all.
		const noBilling = await insertWorkspace(db, actorId, NOT_ENTERPRISE)
		await insertSession(db, noBilling.id, actorId, actorId, recent)
		// Qualifies: a JSON null billing value counts as no block.
		const nullBilling = await insertWorkspace(db, actorId, {
			...NOT_ENTERPRISE,
			settings: { ...noBilling.settings, billing: null },
		})
		await insertSession(db, nullBilling.id, actorId, actorId, recent)
		// Left alone: already has a billing block.
		const hasBilling = await insertWorkspace(db, actorId, {
			...NOT_ENTERPRISE,
			settings: { ...noBilling.settings, billing: existingBilling },
		})
		await insertSession(db, hasBilling.id, actorId, actorId, recent)
		// Left alone: enterprise granted.
		const enterprise = await insertWorkspace(db, actorId, { enterpriseGranted: true })
		await insertSession(db, enterprise.id, actorId, actorId, recent)
		// Left alone: only an old session.
		const staleOnly = await insertWorkspace(db, actorId, NOT_ENTERPRISE)
		await insertSession(db, staleOnly.id, actorId, actorId, stale)
		// Left alone: no session at all.
		const noSession = await insertWorkspace(db, actorId, NOT_ENTERPRISE)

		const ids = [noBilling, nullBilling, hasBilling, enterprise, staleOnly, noSession].map(
			(w) => w.id,
		)
		const read = async (tx: Pick<typeof db, 'select'>) =>
			new Map(
				(
					await tx
						.select({ id: workspaces.id, settings: workspaces.settings })
						.from(workspaces)
						.where(inArray(workspaces.id, ids))
				).map((r) => [r.id, r.settings as Record<string, unknown>]),
			)

		const beforeSec = Math.floor(Date.now() / 1000) - 5
		const first = new Map<string, Record<string, unknown>>()
		const second = new Map<string, Record<string, unknown>>()
		const SENTINEL = 1_800_000_000
		const rollback = new Error('rollback')
		await db
			.transaction(async (tx) => {
				await tx.execute(sql.raw(migration))
				for (const [id, s] of await read(tx)) first.set(id, s)

				// Move the new period to a sentinel, then run again: nothing may touch it.
				await tx
					.update(workspaces)
					.set({
						settings: sql`jsonb_set(${workspaces.settings}, '{billing,period_start}', ${SENTINEL}::text::jsonb)`,
					})
					.where(inArray(workspaces.id, [noBilling.id, nullBilling.id]))
				await tx.execute(sql.raw(migration))
				for (const [id, s] of await read(tx)) second.set(id, s)
				throw rollback
			})
			.catch((err) => {
				if (err !== rollback) throw err
			})
		const afterSec = Math.floor(Date.now() / 1000) + 5

		for (const ws of [noBilling, nullBilling]) {
			const settings = first.get(ws.id) as { billing: { plan: string; period_start: number } }
			expect(settings.billing.plan).toBe('trial')
			// Unix seconds (a ms value would be around 1.7e12).
			expect(settings.billing.period_start).toBeGreaterThanOrEqual(beforeSec)
			expect(settings.billing.period_start).toBeLessThanOrEqual(afterSec)
			// Every other key is kept.
			const { billing: _billing, ...rest } = settings as Record<string, unknown>
			const { billing: _orig, ...origRest } = ws.settings as Record<string, unknown>
			expect(rest).toEqual(origRest)
		}

		expect(first.get(hasBilling.id)).toEqual({ ...noBilling.settings, billing: existingBilling })
		expect(first.get(enterprise.id)).toEqual(enterprise.settings)
		expect(first.get(staleOnly.id)).toEqual(staleOnly.settings)
		expect(first.get(noSession.id)).toEqual(noSession.settings)
		expect(first.get(enterprise.id)).not.toHaveProperty('billing')

		// Second run: the sentinel survives, and the left-alone rows are still unchanged.
		for (const ws of [noBilling, nullBilling]) {
			expect(
				(second.get(ws.id) as { billing: { period_start: number } }).billing.period_start,
			).toBe(SENTINEL)
		}
		for (const ws of [hasBilling, enterprise, staleOnly, noSession]) {
			expect(second.get(ws.id)).toEqual(first.get(ws.id))
		}

		// Rolled back: nothing from the migration is left in the database.
		const [persisted] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, noBilling.id))
		expect(persisted.settings).not.toHaveProperty('billing')
	})

	it('does nothing and does not fail when no workspace qualifies', async () => {
		const rollback = new Error('rollback')
		await db
			.transaction(async (tx) => {
				// Park every workspace outside the rule so the table looks empty to the migration.
				await tx.execute(sql`UPDATE workspaces SET enterprise_granted = true`)
				await expect(tx.execute(sql.raw(migration))).resolves.toBeDefined()
				throw rollback
			})
			.catch((err) => {
				if (err !== rollback) throw err
			})
	})
})
