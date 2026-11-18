import { youtubeQuotaUsage } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { YoutubeError } from '../../lib/integrations/providers/youtube/errors'
import {
	GLOBAL_DAILY_CAP,
	GLOBAL_SCOPE,
	WORKSPACE_DAILY_CAP,
	chargeYoutubeQuota,
} from '../../lib/integrations/providers/youtube/quota'
import { db } from './global-setup'

// Noon Pacific on 14 Oct 2026 (PDT, UTC-7) is 19:00 UTC.
const OCT_14 = new Date('2026-10-14T19:00:00Z')

async function used(scope: string, date: string): Promise<number | null> {
	const [row] = await db
		.select({ n: youtubeQuotaUsage.unitsUsed })
		.from(youtubeQuotaUsage)
		.where(and(eq(youtubeQuotaUsage.scope, scope), eq(youtubeQuotaUsage.quotaDate, date)))
	return row?.n ?? null
}

async function seed(scope: string, date: string, units: number) {
	await db.insert(youtubeQuotaUsage).values({ quotaDate: date, scope, unitsUsed: units })
}

const wsId = () => crypto.randomUUID()

describe('chargeYoutubeQuota', () => {
	beforeEach(async () => {
		await db.delete(youtubeQuotaUsage)
	})

	it('charges the workspace row and the global row', async () => {
		const ws = wsId()
		await chargeYoutubeQuota(db, ws, 1, OCT_14)
		await chargeYoutubeQuota(db, ws, 2, OCT_14)
		expect(await used(ws, '2026-10-14')).toBe(3)
		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBe(3)
	})

	it('parallel calls never exceed the workspace cap', async () => {
		const ws = wsId()
		await seed(ws, '2026-10-14', WORKSPACE_DAILY_CAP - 10)

		const results = await Promise.allSettled(
			Array.from({ length: 25 }, () => chargeYoutubeQuota(db, ws, 1, OCT_14)),
		)

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
		const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
		expect(failed).toHaveLength(15)
		for (const f of failed) expect(f.reason).toMatchObject({ code: 'WORKSPACE_QUOTA_EXHAUSTED' })
		expect(await used(ws, '2026-10-14')).toBe(WORKSPACE_DAILY_CAP)
		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBe(10)
	})

	it('parallel calls from many workspaces never exceed the global cap', async () => {
		await seed(GLOBAL_SCOPE, '2026-10-14', GLOBAL_DAILY_CAP - 8)

		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => chargeYoutubeQuota(db, wsId(), 1, OCT_14)),
		)

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8)
		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBe(GLOBAL_DAILY_CAP)
	})

	it('a workspace cap hit leaves the global count unchanged', async () => {
		const ws = wsId()
		await seed(ws, '2026-10-14', WORKSPACE_DAILY_CAP)
		await seed(GLOBAL_SCOPE, '2026-10-14', 40)

		await expect(chargeYoutubeQuota(db, ws, 1, OCT_14)).rejects.toMatchObject({
			code: 'WORKSPACE_QUOTA_EXHAUSTED',
		})

		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBe(40)
		expect(await used(ws, '2026-10-14')).toBe(WORKSPACE_DAILY_CAP)
	})

	it('a global cap hit rolls back the workspace increment', async () => {
		const ws = wsId()
		await seed(GLOBAL_SCOPE, '2026-10-14', GLOBAL_DAILY_CAP)

		const err = await chargeYoutubeQuota(db, ws, 1, OCT_14).catch((e) => e)

		expect(err).toBeInstanceOf(YoutubeError)
		expect(err.code).toBe('QUOTA_EXHAUSTED')
		expect(await used(ws, '2026-10-14')).toBeNull()
		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBe(GLOBAL_DAILY_CAP)
	})

	it('refuses a first charge that is already above the cap', async () => {
		const ws = wsId()
		await expect(chargeYoutubeQuota(db, ws, WORKSPACE_DAILY_CAP + 1, OCT_14)).rejects.toMatchObject(
			{ code: 'WORKSPACE_QUOTA_EXHAUSTED' },
		)
		expect(await used(ws, '2026-10-14')).toBeNull()
		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBeNull()
	})

	it('refuses a first global charge above the global cap and rolls the workspace back', async () => {
		const ws = wsId()
		await seed(GLOBAL_SCOPE, '2026-10-14', GLOBAL_DAILY_CAP - 1)
		await expect(chargeYoutubeQuota(db, ws, 2, OCT_14)).rejects.toMatchObject({
			code: 'QUOTA_EXHAUSTED',
		})
		expect(await used(ws, '2026-10-14')).toBeNull()
	})

	it('rolls the date at midnight Pacific, not UTC', async () => {
		const ws = wsId()
		// 06:59 UTC on 15 Oct is 23:59 Pacific on 14 Oct (PDT, UTC-7).
		await chargeYoutubeQuota(db, ws, 1, new Date('2026-10-15T06:59:00Z'))
		// 07:00 UTC is 00:00 Pacific on 15 Oct.
		await chargeYoutubeQuota(db, ws, 1, new Date('2026-10-15T07:00:00Z'))

		expect(await used(ws, '2026-10-14')).toBe(1)
		expect(await used(ws, '2026-10-15')).toBe(1)
		expect(await used(GLOBAL_SCOPE, '2026-10-14')).toBe(1)
		expect(await used(GLOBAL_SCOPE, '2026-10-15')).toBe(1)
	})

	it('handles daylight saving: after the November change the roll moves to 08:00 UTC', async () => {
		const ws = wsId()
		// PST (UTC-8) from 1 Nov 2026: 07:30 UTC on 10 Nov is still 9 Nov, 23:30 Pacific.
		await chargeYoutubeQuota(db, ws, 1, new Date('2026-11-10T07:30:00Z'))
		await chargeYoutubeQuota(db, ws, 1, new Date('2026-11-10T08:00:00Z'))

		expect(await used(ws, '2026-11-09')).toBe(1)
		expect(await used(ws, '2026-11-10')).toBe(1)
	})

	it('uses the database clock when no time is given', async () => {
		const ws = wsId()
		await chargeYoutubeQuota(db, ws, 1)
		const rows = await db.select().from(youtubeQuotaUsage).where(eq(youtubeQuotaUsage.scope, ws))
		expect(rows).toHaveLength(1)
		expect(rows[0].unitsUsed).toBe(1)
	})

	it('rejects a charge that is not a positive whole number', async () => {
		await expect(chargeYoutubeQuota(db, wsId(), 0, OCT_14)).rejects.toThrow(/positive whole number/)
		await expect(chargeYoutubeQuota(db, wsId(), 1.5, OCT_14)).rejects.toThrow(
			/positive whole number/,
		)
	})
})
