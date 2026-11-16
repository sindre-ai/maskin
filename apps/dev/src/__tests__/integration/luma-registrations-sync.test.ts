import { readings } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
	type LumaRegistrationsSyncConfig,
	type LumaRegistrationsSyncDeps,
	LumaRegistrationsSyncJob,
} from '../../jobs/luma-registrations-sync'
import { LumaApiError } from '../../lib/luma-api'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const NOW = new Date('2026-11-20T10:07:00Z')

async function setup(depOverrides?: Partial<LumaRegistrationsSyncDeps>) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const config: LumaRegistrationsSyncConfig = {
		workspaceId: ws.id,
		actorId,
		keyName: 'Luma',
	}
	const deps: LumaRegistrationsSyncDeps = {
		readKey: vi.fn(async () => 'key'),
		listCalendarEvents: vi.fn(async () => [
			{ id: 'evt-a', url: 'https://luma.com/webinar-a' },
			{ id: 'evt-b', url: 'https://luma.com/webinar-b' },
		]),
		countGuestsByStatus: vi.fn(async (_key: string, id: string) =>
			id === 'evt-a' ? { approved: 7, waitlist: 2, declined: 1 } : { approved: 4 },
		),
		now: () => NOW,
		...depOverrides,
	}
	const job = new LumaRegistrationsSyncJob(db, config, deps)
	const event = (metadata: Record<string, unknown>, status = 'planned', content = '') =>
		insertObject(db, ws.id, actorId, { type: 'event', status, metadata, content })
	return { ws, job, deps, event }
}

const readingsFor = (subjectId: string) =>
	db.select().from(readings).where(eq(readings.subjectId, subjectId))

describe('LumaRegistrationsSyncJob', () => {
	it('writes the approved count with the other statuses in the detail', async () => {
		const { job, event } = await setup()
		const a = await event({ platform: 'luma', luma_url: 'https://lu.ma/webinar-a' })

		expect(await job.tick()).toBe(1)

		const [row] = await readingsFor(a.id)
		expect(row).toMatchObject({
			measure: 'luma.registrations',
			value: 7,
			source: 'luma-api',
			sourceRef: 'evt-a@2026-11-20T10:00:00.000Z',
		})
		expect(row.readAt.toISOString()).toBe(NOW.toISOString())
		expect(row.detail).toEqual({
			luma_event_id: 'evt-a',
			pending_approval: 0,
			waitlist: 2,
			invited: 0,
			declined: 1,
			session: 0,
		})
	})

	it('finds the listing URL in the event text when no field holds it', async () => {
		const { job, event } = await setup()
		const b = await event({ platform: 'luma' }, 'live', 'Luma page: https://luma.com/webinar-b.')

		expect(await job.tick()).toBe(1)
		expect((await readingsFor(b.id))[0].value).toBe(4)
	})

	it('is safe to re-run: a second run in the same 30-minute slot adds nothing', async () => {
		const { job, event } = await setup()
		const a = await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-a' })

		expect(await job.tick()).toBe(1)
		expect(await job.tick()).toBe(0)
		expect(await readingsFor(a.id)).toHaveLength(1)
	})

	it('only reads luma events between planned and live', async () => {
		const { job, event, deps } = await setup()
		const meta = { platform: 'luma', luma_url: 'https://luma.com/webinar-a' }
		const proposed = await event(meta, 'proposed')
		const wrapped = await event(meta, 'wrapped_up')
		const other = await event({ platform: 'meetup', luma_url: 'https://luma.com/webinar-a' })

		expect(await job.tick()).toBe(0)
		for (const e of [proposed, wrapped, other]) expect(await readingsFor(e.id)).toHaveLength(0)
		// Nothing to read means Luma is not called at all.
		expect(deps.listCalendarEvents).not.toHaveBeenCalled()
	})

	it('skips an event with no listing URL or one that is not on the calendar, and reads the rest', async () => {
		const { job, event } = await setup()
		const noUrl = await event({ platform: 'luma' })
		const unknown = await event({ platform: 'luma', luma_url: 'https://luma.com/not-ours' })
		const ok = await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-b' })

		expect(await job.tick()).toBe(1)
		expect(await readingsFor(noUrl.id)).toHaveLength(0)
		expect(await readingsFor(unknown.id)).toHaveLength(0)
		expect(await readingsFor(ok.id)).toHaveLength(1)
	})

	it('writes nothing for an event whose guest list fails, and carries on with the next', async () => {
		const { job, event } = await setup({
			countGuestsByStatus: vi.fn(async (_k: string, id: string) => {
				if (id === 'evt-a') throw new LumaApiError(500, 'boom')
				return { approved: 4 }
			}),
		})
		const a = await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-a' })
		const b = await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-b' })

		expect(await job.tick()).toBe(1)
		expect(await readingsFor(a.id)).toHaveLength(0)
		expect(await readingsFor(b.id)).toHaveLength(1)
	})

	it('stops the run on a 429 instead of failing every remaining event', async () => {
		const countGuestsByStatus = vi.fn(async () => {
			throw new LumaApiError(429, 'slow down', 60)
		})
		const { job, event } = await setup({ countGuestsByStatus })
		await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-a' })
		await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-b' })

		expect(await job.tick()).toBe(0)
		expect(countGuestsByStatus).toHaveBeenCalledTimes(1)
	})

	it('does nothing without a key, and never throws', async () => {
		const readKey = vi.fn(async () => null)
		const { job, event, deps } = await setup({ readKey })
		const a = await event({ platform: 'luma', luma_url: 'https://luma.com/webinar-a' })

		expect(await job.tick()).toBe(0)
		expect(await job.tick()).toBe(0)
		expect(readKey).toHaveBeenCalledTimes(2)
		expect(deps.listCalendarEvents).not.toHaveBeenCalled()
		expect(await readingsFor(a.id)).toHaveLength(0)
	})

	it('does not throw when the key lookup or the calendar call blows up', async () => {
		const failingKey = await setup({
			readKey: vi.fn(async () => {
				throw new Error('keychain down')
			}),
		})
		expect(await failingKey.job.tick()).toBe(0)

		const failingCalendar = await setup({
			listCalendarEvents: vi.fn(async () => {
				throw new LumaApiError(401, 'bad key')
			}),
		})
		await failingCalendar.event({ platform: 'luma', luma_url: 'https://luma.com/webinar-a' })
		expect(await failingCalendar.job.tick()).toBe(0)
	})
})
