/**
 * Briefing + lifecycle push schedulers against real Postgres.
 * Proves the DB semantics the schedulers depend on: the conditional-UPDATE day claim (two
 * concurrent ticks send ONE briefing), the next local date sends again, and the jsonb
 * once-only claim for lifecycle pushes.
 */
import { randomUUID } from 'node:crypto'
import {
	deviceTokens,
	notificationPreferences,
	notifications,
	workspaceMembers,
} from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { BriefingPushScheduler } from '../../services/briefing-push-scheduler'
import { LifecyclePushScheduler } from '../../services/lifecycle-push-scheduler'
import { insertActor, insertNotification, insertSession, insertWorkspace } from '../factories'
import { db } from './global-setup'

const HOUR = 3600_000
const DAY = 24 * HOUR

async function human(createdAt = new Date()) {
	const a = await insertActor(db, { type: 'human', createdAt })
	return a?.id as string
}

async function agent(workspaceId: string, name = 'Researcher') {
	const a = await insertActor(db, { type: 'agent', name })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId, actorId: a?.id as string, role: 'member' })
	return a?.id as string
}

async function setup(opts: { createdAt?: Date; device?: boolean; agentName?: string } = {}) {
	const actorId = await human(opts.createdAt)
	const ws = await insertWorkspace(db, actorId)
	const workspaceId = ws?.id as string
	const agentId = await agent(workspaceId, opts.agentName)
	if (opts.device !== false) {
		await db.insert(deviceTokens).values({
			actorId,
			platform: 'ios',
			apnsToken: randomUUID().replace(/-/g, ''),
			environment: 'sandbox',
		})
	}
	return { actorId, workspaceId, agentId }
}

async function prefs(actorId: string, over: Partial<typeof notificationPreferences.$inferInsert>) {
	await db.insert(notificationPreferences).values({ actorId, ...over })
}

async function forYouCard(
	workspaceId: string,
	agentId: string,
	actorId: string,
	headline: string,
	createdAt = new Date(),
) {
	return insertNotification(db, workspaceId, agentId, {
		targetActorId: actorId,
		type: 'needs_input',
		status: 'pending',
		createdAt,
		metadata: { kind: FOR_YOU_KIND, rank: 1, headline },
	})
}

async function kindRows(actorId: string, kind: string) {
	return db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.targetActorId, actorId),
				sql`${notifications.metadata}->>'kind' = ${kind}`,
			),
		)
}

const prefsRow = async (actorId: string) =>
	(
		await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
	)[0]

describe('briefing push scheduler', () => {
	// 08:40 in Oslo (CET, UTC+1); briefing_time defaults to 08:30.
	const day1 = new Date('2026-03-10T07:40:00Z')
	const day2 = new Date('2026-03-11T07:40:00Z')

	it('two concurrent ticks (two replicas) send ONE briefing; the next local day sends again', async () => {
		const { actorId, workspaceId, agentId } = await setup()
		await prefs(actorId, { timezone: 'Europe/Oslo' })
		await forYouCard(workspaceId, agentId, actorId, 'Approve the launch email')

		const a = new BriefingPushScheduler(db, {})
		const b = new BriefingPushScheduler(db, {})
		await Promise.all([a.tick(day1), b.tick(day1)])

		let rows = await kindRows(actorId, 'daily_briefing')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			type: 'recommendation',
			title: '1 thing needs you',
			content: 'Approve the launch email',
			workspaceId,
			sourceActorId: agentId,
			status: 'pending',
			objectId: null,
		})
		expect(rows[0]?.metadata).toMatchObject({
			push_category: 'digest',
			push_force: true,
			push_collapse_key: 'briefing:2026-03-10',
			briefing_date: '2026-03-10',
		})
		expect((await prefsRow(actorId))?.briefingLastSentOn).toBe('2026-03-10')

		// Same day, later: nothing more. A "restarted" scheduler instance too.
		await a.tick(new Date('2026-03-10T08:10:00Z'))
		await new BriefingPushScheduler(db, {}).tick(new Date('2026-03-10T08:11:00Z'))
		expect(await kindRows(actorId, 'daily_briefing')).toHaveLength(1)

		// Next local date: a second briefing, with its own collapse key.
		await new BriefingPushScheduler(db, {}).tick(day2)
		rows = await kindRows(actorId, 'daily_briefing')
		expect(rows).toHaveLength(2)
		expect(
			rows.map((r) => (r.metadata as Record<string, unknown>).push_collapse_key).sort(),
		).toEqual(['briefing:2026-03-10', 'briefing:2026-03-11'])
	})

	it('counts the same cards GET /api/for-you shows, ignoring closed/ended ones', async () => {
		const { actorId, workspaceId, agentId } = await setup()
		await prefs(actorId, { timezone: 'Europe/Oslo' })
		await forYouCard(workspaceId, agentId, actorId, 'Pick a date')
		await forYouCard(workspaceId, agentId, actorId, 'Pick a venue')
		// Its session already ended: For You hides it, so the briefing must not count it.
		const done = await insertSession(db, workspaceId, agentId, actorId, {
			status: 'completed',
			completedAt: new Date('2020-01-01T00:00:00Z'),
		})
		await insertNotification(db, workspaceId, agentId, {
			targetActorId: actorId,
			type: 'needs_input',
			status: 'pending',
			sessionId: done?.id,
			metadata: { kind: FOR_YOU_KIND, rank: 1, headline: 'Stale ask' },
		})
		await new BriefingPushScheduler(db, {}).tick(day1)
		const [row] = await kindRows(actorId, 'daily_briefing')
		expect(row?.title).toBe('2 things need you')
	})

	it('mentions a finished run and skips (recording nothing) when there is nothing to say', async () => {
		const quiet = await setup()
		await prefs(quiet.actorId, { timezone: 'Europe/Oslo' })
		const busy = await setup({ agentName: 'Writer' })
		await prefs(busy.actorId, { timezone: 'Europe/Oslo' })
		await insertSession(db, busy.workspaceId, busy.agentId, busy.actorId, {
			status: 'completed',
			interactive: false,
			completedAt: new Date(day1.getTime() - 2 * HOUR),
		})

		await new BriefingPushScheduler(db, {}).tick(day1)

		expect(await kindRows(quiet.actorId, 'daily_briefing')).toHaveLength(0)
		expect((await prefsRow(quiet.actorId))?.briefingLastSentOn).toBeNull()
		const [row] = await kindRows(busy.actorId, 'daily_briefing')
		expect(row?.title).toBe('Writer finished a task')
	})

	it('never sends without a timezone, device, before the time, after the window, or when disabled', async () => {
		const cases: Array<[string, Partial<typeof notificationPreferences.$inferInsert>, boolean]> = [
			['no timezone', { timezone: null }, true],
			['not yet 08:30', { timezone: 'America/New_York' }, true], // 03:40 there
			['window over', { timezone: 'Asia/Tokyo' }, true], // 16:40 there
			['disabled', { timezone: 'Europe/Oslo', briefingEnabled: false }, true],
			['no device', { timezone: 'Europe/Oslo' }, false],
		]
		for (const [label, over, device] of cases) {
			const s = await setup({ device })
			await prefs(s.actorId, over)
			await forYouCard(s.workspaceId, s.agentId, s.actorId, `Ask ${label}`)
			await new BriefingPushScheduler(db, {}).tick(day1)
			expect(await kindRows(s.actorId, 'daily_briefing'), label).toHaveLength(0)
		}
	})

	it('an invalid stored timezone does not crash the tick or block other actors', async () => {
		const bad = await setup()
		await prefs(bad.actorId, { timezone: 'Not/AZone' })
		await forYouCard(bad.workspaceId, bad.agentId, bad.actorId, 'x')
		const good = await setup()
		await prefs(good.actorId, { timezone: 'Europe/Oslo' })
		await forYouCard(good.workspaceId, good.agentId, good.actorId, 'y')

		await expect(new BriefingPushScheduler(db, {}).tick(day1)).resolves.toBeGreaterThanOrEqual(1)
		expect(await kindRows(bad.actorId, 'daily_briefing')).toHaveLength(0)
		expect(await kindRows(good.actorId, 'daily_briefing')).toHaveLength(1)
	})

	it('DST: spring-forward day sends once, at the first minute after the skipped target', async () => {
		const s = await setup()
		// 02:30 local does not exist in Oslo on 2026-03-29 (02:00 -> 03:00).
		await prefs(s.actorId, { timezone: 'Europe/Oslo', briefingTime: 150 })
		await forYouCard(s.workspaceId, s.agentId, s.actorId, 'DST ask')
		const sched = new BriefingPushScheduler(db, {})
		await sched.tick(new Date('2026-03-29T00:59:00Z')) // 01:59 local
		expect(await kindRows(s.actorId, 'daily_briefing')).toHaveLength(0)
		await sched.tick(new Date('2026-03-29T01:00:00Z')) // 03:00 local
		await sched.tick(new Date('2026-03-29T01:01:00Z'))
		const rows = await kindRows(s.actorId, 'daily_briefing')
		expect(rows).toHaveLength(1)
		expect((rows[0]?.metadata as Record<string, unknown>).briefing_date).toBe('2026-03-29')
	})

	it('multi-workspace: one briefing, anchored on the workspace with the most waiting', async () => {
		const s = await setup()
		await prefs(s.actorId, { timezone: 'Europe/Oslo' })
		await forYouCard(s.workspaceId, s.agentId, s.actorId, 'One here')
		const ws2 = await insertWorkspace(db, s.actorId, { name: 'Second' })
		const agent2 = await agent(ws2?.id as string)
		await forYouCard(ws2?.id as string, agent2, s.actorId, 'A')
		await forYouCard(ws2?.id as string, agent2, s.actorId, 'B')

		await new BriefingPushScheduler(db, {}).tick(day1)
		const rows = await kindRows(s.actorId, 'daily_briefing')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ workspaceId: ws2?.id, title: '2 things need you' })
		expect(rows[0]?.content).toContain('1 more in other workspaces')
	})

	it('a muted workspace is left out; FEATURE_BRIEFING_PUSH=0 sends nothing', async () => {
		const s = await setup()
		await prefs(s.actorId, { timezone: 'Europe/Oslo', mutedWorkspaceIds: [s.workspaceId] })
		await forYouCard(s.workspaceId, s.agentId, s.actorId, 'muted ask')
		const t = await setup()
		await prefs(t.actorId, { timezone: 'Europe/Oslo' })
		await forYouCard(t.workspaceId, t.agentId, t.actorId, 'ask')

		await new BriefingPushScheduler(db, { FEATURE_BRIEFING_PUSH: '0' }).tick(day1)
		expect(await kindRows(t.actorId, 'daily_briefing')).toHaveLength(0)
		await new BriefingPushScheduler(db, {}).tick(day1)
		expect(await kindRows(s.actorId, 'daily_briefing')).toHaveLength(0)
		expect(await kindRows(t.actorId, 'daily_briefing')).toHaveLength(1)
	})
})

describe('lifecycle push scheduler', () => {
	const on = { PUSH_LIFECYCLE_ENABLED: '1' }

	it('is off by default', async () => {
		const s = await setup({ createdAt: new Date(Date.now() - 4 * DAY) })
		await new LifecyclePushScheduler(db, {}).tick(new Date())
		expect(await kindRows(s.actorId, 'lifecycle_activation')).toHaveLength(0)
	})

	it('first_task: sent once even with concurrent ticks; never for a later run or an old account', async () => {
		const now = new Date()
		const s = await setup({ createdAt: new Date(now.getTime() - 2 * DAY) })
		const first = await insertSession(db, s.workspaceId, s.agentId, s.actorId, {
			status: 'completed',
			interactive: false,
			completedAt: new Date(now.getTime() - HOUR),
		})
		await Promise.all([
			new LifecyclePushScheduler(db, on).tick(now),
			new LifecyclePushScheduler(db, on).tick(now),
		])
		let rows = await kindRows(s.actorId, 'lifecycle_first_task')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			title: 'Your agent finished its first task',
			sessionId: first?.id,
			sourceActorId: s.agentId,
		})
		expect(rows[0]?.metadata).toMatchObject({
			push_category: 'tips',
			push_force: true,
		})
		expect((await prefsRow(s.actorId))?.lifecycleSent).toHaveProperty('first_task')

		// A later successful run, and further ticks: still just the one.
		await insertSession(db, s.workspaceId, s.agentId, s.actorId, {
			status: 'completed',
			interactive: false,
			completedAt: new Date(now.getTime() - 60_000),
		})
		await new LifecyclePushScheduler(db, on).tick(now)
		rows = await kindRows(s.actorId, 'lifecycle_first_task')
		expect(rows).toHaveLength(1)

		// Signed up 20 days ago: outside the 14-day window.
		const old = await setup({ createdAt: new Date(now.getTime() - 20 * DAY) })
		await insertSession(db, old.workspaceId, old.agentId, old.actorId, {
			status: 'completed',
			interactive: false,
			completedAt: new Date(now.getTime() - HOUR),
		})
		await new LifecyclePushScheduler(db, on).tick(now)
		expect(await kindRows(old.actorId, 'lifecycle_first_task')).toHaveLength(0)
	})

	it('first_task: skipped when an earlier successful run exists, or the run failed or was a chat', async () => {
		const now = new Date()
		const earlier = await setup({ createdAt: new Date(now.getTime() - 2 * DAY) })
		await insertSession(db, earlier.workspaceId, earlier.agentId, earlier.actorId, {
			status: 'completed',
			interactive: false,
			completedAt: new Date(now.getTime() - 3 * DAY),
		})
		await insertSession(db, earlier.workspaceId, earlier.agentId, earlier.actorId, {
			status: 'completed',
			interactive: false,
			completedAt: new Date(now.getTime() - HOUR),
		})
		const failed = await setup({ createdAt: new Date(now.getTime() - 2 * DAY) })
		await insertSession(db, failed.workspaceId, failed.agentId, failed.actorId, {
			status: 'failed',
			completedAt: new Date(now.getTime() - HOUR),
		})
		const chat = await setup({ createdAt: new Date(now.getTime() - 2 * DAY) })
		await insertSession(db, chat.workspaceId, chat.agentId, chat.actorId, {
			status: 'completed',
			interactive: true,
			completedAt: new Date(now.getTime() - HOUR),
		})
		await new LifecyclePushScheduler(db, on).tick(now)
		for (const s of [earlier, failed, chat]) {
			expect(await kindRows(s.actorId, 'lifecycle_first_task')).toHaveLength(0)
		}
	})

	it('reminder: one per decision after 24h, max one per day, never for fresh or ancient ones', async () => {
		const now = new Date()
		const s = await setup({ createdAt: new Date(now.getTime() - 30 * DAY) })
		const c1 = await forYouCard(
			s.workspaceId,
			s.agentId,
			s.actorId,
			'Old ask',
			new Date(now.getTime() - 30 * HOUR),
		)
		const c2 = await forYouCard(
			s.workspaceId,
			s.agentId,
			s.actorId,
			'Second ask',
			new Date(now.getTime() - 28 * HOUR),
		)
		await forYouCard(
			s.workspaceId,
			s.agentId,
			s.actorId,
			'Fresh ask',
			new Date(now.getTime() - 10 * HOUR),
		)
		await forYouCard(
			s.workspaceId,
			s.agentId,
			s.actorId,
			'Ancient ask',
			new Date(now.getTime() - 100 * HOUR),
		)

		await Promise.all([
			new LifecyclePushScheduler(db, on).tick(now),
			new LifecyclePushScheduler(db, on).tick(now),
		])
		let rows = await kindRows(s.actorId, 'lifecycle_reminder')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ title: 'Still waiting on you', content: 'Old ask' })
		expect(rows[0]?.metadata).toMatchObject({ reminder_for: c1?.id, push_category: 'tips' })

		// Same day: the second card must wait.
		await new LifecyclePushScheduler(db, on).tick(new Date(now.getTime() + 2 * HOUR))
		expect(await kindRows(s.actorId, 'lifecycle_reminder')).toHaveLength(1)

		// 25 hours later the second card (53h old) gets its one reminder; the first never repeats.
		const later = new Date(now.getTime() + 25 * HOUR)
		await new LifecyclePushScheduler(db, on).tick(later)
		await new LifecyclePushScheduler(db, on).tick(new Date(later.getTime() + 60_000))
		rows = await kindRows(s.actorId, 'lifecycle_reminder')
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => (r.metadata as Record<string, unknown>).reminder_for).sort()).toEqual(
			[c1?.id, c2?.id].sort(),
		)
	})

	it('reminder: not sent once the decision is no longer live', async () => {
		const now = new Date()
		const s = await setup({ createdAt: new Date(now.getTime() - 30 * DAY) })
		const ended = await insertSession(db, s.workspaceId, s.agentId, s.actorId, {
			status: 'completed',
			completedAt: new Date(now.getTime() - 26 * HOUR),
		})
		await insertNotification(db, s.workspaceId, s.agentId, {
			targetActorId: s.actorId,
			type: 'needs_input',
			status: 'pending',
			sessionId: ended?.id,
			createdAt: new Date(now.getTime() - 30 * HOUR),
			metadata: { kind: FOR_YOU_KIND, rank: 1, headline: 'Moot' },
		})
		const resolved = await forYouCard(
			s.workspaceId,
			s.agentId,
			s.actorId,
			'Answered',
			new Date(now.getTime() - 30 * HOUR),
		)
		await db
			.update(notifications)
			.set({ status: 'resolved' })
			.where(eq(notifications.id, resolved?.id as string))
		await new LifecyclePushScheduler(db, on).tick(now)
		expect(await kindRows(s.actorId, 'lifecycle_reminder')).toHaveLength(0)
	})

	it('activation: once, 3-5 days after sign-up, only if no session was ever started', async () => {
		const now = new Date()
		const target = await setup({ createdAt: new Date(now.getTime() - 4 * DAY) })
		const started = await setup({ createdAt: new Date(now.getTime() - 4 * DAY) })
		await insertSession(db, started.workspaceId, started.agentId, started.actorId, {
			status: 'running',
		})
		const tooNew = await setup({ createdAt: new Date(now.getTime() - 1 * DAY) })
		const tooOld = await setup({ createdAt: new Date(now.getTime() - 10 * DAY) })
		const noDevice = await setup({ createdAt: new Date(now.getTime() - 4 * DAY), device: false })

		await Promise.all([
			new LifecyclePushScheduler(db, on).tick(now),
			new LifecyclePushScheduler(db, on).tick(now),
		])
		await new LifecyclePushScheduler(db, on).tick(new Date(now.getTime() + 10 * 60_000))

		const rows = await kindRows(target.actorId, 'lifecycle_activation')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			workspaceId: target.workspaceId,
			sourceActorId: target.agentId,
		})
		expect(rows[0]?.metadata).toMatchObject({ push_category: 'tips', push_force: true })
		for (const s of [started, tooNew, tooOld, noDevice]) {
			expect(await kindRows(s.actorId, 'lifecycle_activation')).toHaveLength(0)
		}
	})

	it('the claim rolls back with the notification (a failed insert does not burn the key)', async () => {
		const now = new Date()
		const s = await setup({ createdAt: new Date(now.getTime() - 4 * DAY) })
		// Break the notification insert for this actor's only candidate workspace by removing the
		// agent: no source actor can be resolved, so nothing is claimed.
		await db.delete(workspaceMembers).where(eq(workspaceMembers.actorId, s.agentId))
		await new LifecyclePushScheduler(db, on).tick(now)
		expect(await kindRows(s.actorId, 'lifecycle_activation')).toHaveLength(0)
		expect((await prefsRow(s.actorId))?.lifecycleSent ?? {}).not.toHaveProperty('activation')
	})
})
