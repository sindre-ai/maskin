import { readings } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ReadingError, latestReadings, readingKey, recordReading } from '../../lib/readings'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Readings against real Postgres: append-only, one row per source reference, the newest row per
 * subject and measure is the current one, and a subject outside the workspace is refused.
 */

async function setup() {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const event = await insertObject(db, workspace.id, human, { type: 'event', title: 'Webinar' })
	return { workspaceId: workspace.id, subjectId: event.id, human }
}

const input = (
	ctx: { workspaceId: string; subjectId: string },
	overrides: Partial<Parameters<typeof recordReading>[1]> = {},
) => ({
	workspaceId: ctx.workspaceId,
	subjectId: ctx.subjectId,
	measure: 'luma.registrations',
	value: 12,
	readAt: new Date('2026-11-12T10:00:00Z'),
	source: 'luma-api',
	sourceRef: 'poll-2026-11-12T10:00',
	detail: { waitlist: 3 },
	...overrides,
})

describe('readings', () => {
	it('stores a reading with its time, source and detail', async () => {
		const ctx = await setup()
		expect(await recordReading(db, input(ctx))).toEqual({ inserted: true })

		const [row] = await db.select().from(readings).where(eq(readings.subjectId, ctx.subjectId))
		expect(row).toMatchObject({
			workspaceId: ctx.workspaceId,
			measure: 'luma.registrations',
			value: 12,
			source: 'luma-api',
			sourceRef: 'poll-2026-11-12T10:00',
			detail: { waitlist: 3 },
		})
		expect(row.readAt.toISOString()).toBe('2026-11-12T10:00:00.000Z')
	})

	it('adds no second row for a repeated write with the same source reference', async () => {
		const ctx = await setup()
		expect(await recordReading(db, input(ctx))).toEqual({ inserted: true })
		expect(await recordReading(db, input(ctx, { value: 99 }))).toEqual({ inserted: false })

		const rows = await db.select().from(readings).where(eq(readings.subjectId, ctx.subjectId))
		expect(rows).toHaveLength(1)
		expect(rows[0].value).toBe(12)
	})

	it('treats the same reference from another source or measure as a new reading', async () => {
		const ctx = await setup()
		await recordReading(db, input(ctx))
		expect(await recordReading(db, input(ctx, { source: 'luma-webhook' }))).toEqual({
			inserted: true,
		})
		expect(await recordReading(db, input(ctx, { measure: 'luma.waitlist' }))).toEqual({
			inserted: true,
		})
	})

	it('refuses to edit a stored reading, and still lets the subject be deleted', async () => {
		const ctx = await setup()
		await recordReading(db, input(ctx))

		await expect(
			db.update(readings).set({ value: 1000 }).where(eq(readings.subjectId, ctx.subjectId)),
		).rejects.toThrow()
		const [row] = await db.select().from(readings).where(eq(readings.subjectId, ctx.subjectId))
		expect(row.value).toBe(12)

		const { objects } = await import('@maskin/db/schema')
		await db.delete(objects).where(eq(objects.id, ctx.subjectId))
		expect(await db.select().from(readings).where(eq(readings.subjectId, ctx.subjectId))).toEqual(
			[],
		)
	})

	it('returns the newest reading per subject and measure', async () => {
		const ctx = await setup()
		await recordReading(
			db,
			input(ctx, { value: 5, sourceRef: 'a', readAt: new Date('2026-11-12T08:00:00Z') }),
		)
		await recordReading(
			db,
			input(ctx, { value: 20, sourceRef: 'b', readAt: new Date('2026-11-12T12:00:00Z') }),
		)
		await recordReading(
			db,
			input(ctx, { value: 11, sourceRef: 'c', readAt: new Date('2026-11-12T10:00:00Z') }),
		)
		await recordReading(db, input(ctx, { measure: 'luma.waitlist', value: 7, sourceRef: 'a' }))

		const latest = await latestReadings(
			db,
			ctx.workspaceId,
			[ctx.subjectId],
			['luma.registrations', 'luma.waitlist'],
		)
		expect(latest.get(readingKey(ctx.subjectId, 'luma.registrations'))?.value).toBe(20)
		expect(latest.get(readingKey(ctx.subjectId, 'luma.waitlist'))?.value).toBe(7)
		expect(latest.size).toBe(2)
	})

	it('does not return readings of another workspace', async () => {
		const ctx = await setup()
		await recordReading(db, input(ctx))
		const other = await setup()

		const latest = await latestReadings(
			db,
			other.workspaceId,
			[ctx.subjectId],
			['luma.registrations'],
		)
		expect(latest.size).toBe(0)
	})

	it('refuses a subject outside the workspace, a bad measure and a non-finite value', async () => {
		const ctx = await setup()
		const other = await setup()

		await expect(recordReading(db, input(ctx, { subjectId: other.subjectId }))).rejects.toThrow(
			ReadingError,
		)
		await expect(recordReading(db, input(ctx, { measure: 'registrations' }))).rejects.toThrow(
			ReadingError,
		)
		await expect(recordReading(db, input(ctx, { value: Number.NaN }))).rejects.toThrow(ReadingError)
		expect(
			await db.select().from(readings).where(eq(readings.workspaceId, ctx.workspaceId)),
		).toEqual([])
	})

	it('refuses a bad measure at the database even when the helper is bypassed', async () => {
		const ctx = await setup()
		await expect(
			db.insert(readings).values({
				workspaceId: ctx.workspaceId,
				subjectId: ctx.subjectId,
				measure: 'Not A Measure',
				value: 1,
				readAt: new Date(),
				source: 's',
				sourceRef: 'r',
			}),
		).rejects.toThrow()
	})
})
