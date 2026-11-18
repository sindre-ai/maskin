// Daily budget 1b: work that is not urgent waits when the day's spend has reached the stop-at share
// of the target, and runs later, most important first. Work a person started never waits.

import { events, sessionDispatchAttempts, sessions, workspaces } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RELEASE_BATCH, releaseHeldSessions } from '../../services/held-session-release'
import { admitSessionStart } from '../../services/self-start-limits'
import { SessionDispatchQueue } from '../../services/session-dispatch-queue'
import { configureSessionLifecycle, startSession } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { ensureWorkspaceMember, insertActor, insertSession, insertWorkspace } from '../factories'
import { db } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// A plan limit of $100, so a session that cost $1 is 1% of the plan.
const PLAN_CAP_CENTS = 10_000

describe('daily budget hold (Integration)', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let manager: SessionManager
	let queue: SessionDispatchQueue

	const setBudget = async (daily_budget: Record<string, unknown> | null) => {
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		const { daily_budget: _old, ...rest } = (ws?.settings ?? {}) as Record<string, unknown>
		await db
			.update(workspaces)
			.set({ settings: (daily_budget ? { ...rest, daily_budget } : rest) as never })
			.where(eq(workspaces.id, workspaceId))
	}

	// Spend today, in percent of the plan: a finished run that cost this many dollars.
	const spendToday = (percent: number) =>
		insertSession(db, workspaceId, agentId, humanId, {
			status: 'completed',
			totalCostUsd: String(percent),
			completedAt: new Date(),
		})

	const start = (reason: string, over: Record<string, unknown> = {}) =>
		startSession({
			workspaceId,
			actorId: agentId,
			callerKind: 'trigger',
			actionPrompt: 'Do the thing',
			config: { start_reason: reason },
			initiatedFromObjectId: null,
			createdBy: humanId,
			...over,
		})

	const row = async (id: string) => {
		const [r] = await db.select().from(sessions).where(eq(sessions.id, id))
		return r as typeof sessions.$inferSelect
	}

	// createSession starts the session in the background; wait until it has left 'pending'.
	const settled = async (id: string) => {
		for (let i = 0; i < 50; i++) {
			const r = await row(id)
			if (r.status !== 'pending') return r
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		return row(id)
	}

	const queueRow = async (id: string) => {
		const [r] = await db
			.select()
			.from(sessionDispatchAttempts)
			.where(eq(sessionDispatchAttempts.sessionId, id))
		return r
	}

	const admissionEvents = (sessionId: string) =>
		db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, 'session_admission'),
					eq(events.entityId, sessionId),
				),
			)
			.orderBy(asc(events.id))

	const deps = () => ({
		db,
		makeDue: (id: string) => queue.makeDue(id),
		freeStartSlots: (w: string) => manager.freeStartSlots(w),
	})

	beforeEach(async () => {
		humanId = (await insertActor(db, { type: 'human' })).id
		workspaceId = (
			await insertWorkspace(db, humanId, {
				// The factory makes unmetered (enterprise) workspaces, which have no plan to take a percent of.
				enterpriseGranted: false,
				settings: { billing: { plan: 'pro', hard_cap_usd_cents: PLAN_CAP_CENTS } },
			})
		).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Worker' })).id
		await ensureWorkspaceMember(db, workspaceId, agentId)
		manager = new SessionManager(db, stubStorage())
		// The queue never ticks here: rows only wait in it, as they would behind a full pool.
		queue = new SessionDispatchQueue(db, async () => ({ kind: 'no_capacity' }))
		manager.setDispatchQueue(queue)
		configureSessionLifecycle({ db, sessionManager: manager })
	})

	afterEach(async () => {
		await manager.stop()
	})

	describe('the gate', () => {
		const admit = (reason: string, over: Record<string, unknown> = {}, env = {}) =>
			admitSessionStart(
				db,
				{
					workspaceId,
					actorId: agentId,
					callerKind: 'trigger',
					config: { start_reason: reason },
					hasChat: false,
					createdBy: humanId,
					initiatedFromObjectId: null,
					...over,
				},
				env,
			)

		it('holds scheduled and state-change work once spend reaches the target', async () => {
			await setBudget({ unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' })
			await spendToday(5)
			const cron = await admit('trigger_cron')
			expect(cron.importance).toBe('low')
			expect(cron.hold?.importance).toBe('low')
			const event = await admit('trigger_event')
			expect(event.importance).toBe('normal')
			expect(event.hold?.importance).toBe('normal')
		})

		it('never holds work a person started, or human-facing work, even over the target', async () => {
			await setBudget({ unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' })
			await spendToday(50)
			expect((await admit('person')).hold).toBeUndefined()
			expect((await admit('trigger_cron', { humanFacing: true })).hold).toBeUndefined()
			expect((await admit('internal')).hold).toBeUndefined()
		})

		it('holds at the stop-at share, not only at the target', async () => {
			await setBudget({ unit: 'percent', amount: 10, stop_share: 80, timezone: 'UTC' })
			await spendToday(7.9)
			expect((await admit('trigger_cron')).hold).toBeUndefined()
			await spendToday(0.1)
			expect((await admit('trigger_cron')).hold).toBeDefined()
		})

		it('changes nothing with no target, under the line, or with the switch off', async () => {
			await spendToday(50)
			expect((await admit('trigger_cron')).hold).toBeUndefined()
			await setBudget({ unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' })
			expect(
				(await admit('trigger_cron', {}, { FEATURE_DAILY_BUDGET_HOLD: '0' })).hold,
			).toBeUndefined()
			await setBudget({ unit: 'percent', amount: 90, stop_share: 100, timezone: 'UTC' })
			expect((await admit('trigger_cron')).hold).toBeUndefined()
		})
	})

	describe('startSession', () => {
		beforeEach(async () => {
			await setBudget({ unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' })
			await spendToday(5)
		})

		it('parks background work as waiting, with one deferred admission event', async () => {
			const handle = await start('trigger_cron')
			const parked = await row(handle.sessionId)
			expect(parked.status).toBe('starting')
			expect(parked.sessionState).toBe('waiting_for_machine')
			expect((parked.config as { held?: { importance?: string } }).held?.importance).toBe('low')

			const queued = await queueRow(handle.sessionId)
			expect(queued?.status).toBe('pending')
			expect(queued?.attempt).toBe(0)
			// Not due until the next day: nothing dispatches it.
			expect(queued?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000)

			// The event is written in the background; give it a moment.
			await new Promise((r) => setTimeout(r, 300))
			const written = await admissionEvents(handle.sessionId)
			expect(written).toHaveLength(1)
			expect(written[0]?.data).toMatchObject({ decision: 'deferred', priority: 'low' })
		})

		it('starts a session a person started at once, even over the target', async () => {
			const handle = await start('person', { callerKind: 'rest' })
			const started = await settled(handle.sessionId)
			expect((started.config as { held?: unknown }).held).toBeUndefined()
			expect((await queueRow(handle.sessionId))?.nextAttemptAt.getTime()).toBeLessThanOrEqual(
				Date.now() + 1000,
			)
		})

		it('does not count held sessions against the workspace start limit', async () => {
			for (let i = 0; i < 10; i++) await start('trigger_cron')
			expect(await manager.freeStartSlots(workspaceId)).toBe(10)
			const urgent = await start('person', { callerKind: 'rest' })
			const started = await settled(urgent.sessionId)
			expect(started.status).toBe('starting')
			expect((started.config as { held?: unknown }).held).toBeUndefined()
			expect(await manager.freeStartSlots(workspaceId)).toBe(9)
		})
	})

	describe('letting held work go', () => {
		let ids: Record<string, string>

		beforeEach(async () => {
			await setBudget({ unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' })
			const spent = await spendToday(5)
			// Oldest first within a level; a low one arrives before the normal ones.
			ids = {}
			ids.low1 = (await start('trigger_cron')).sessionId
			ids.normal1 = (await start('trigger_event')).sessionId
			ids.low2 = (await start('self_wakeup')).sessionId
			ids.normal2 = (await start('agent_request')).sessionId
			ids.normal3 = (await start('task_restart')).sessionId
			ids.low3 = (await start('sweep')).sessionId
			ids.normal4 = (await start('retry')).sessionId
			// Keep the spend row to lower later.
			ids.spent = spent?.id as string
		})

		const releasedIds = async () => {
			const held = Object.entries(ids).filter(([k]) => k !== 'spent')
			const rows = await db
				.select()
				.from(sessions)
				.where(
					inArray(
						sessions.id,
						held.map(([, v]) => v),
					),
				)
			return held
				.filter(([, id]) => {
					const config = rows.find((r) => r.id === id)?.config as {
						held?: { released_at?: string }
					}
					return Boolean(config?.held?.released_at)
				})
				.map(([name]) => name)
		}

		it('keeps everything held while spend is still at the line', async () => {
			expect(await releaseHeldSessions(deps())).toBe(0)
			expect(await releasedIds()).toEqual([])
		})

		it('lets go most important first, oldest first within a level, a batch at a time', async () => {
			await db
				.update(sessions)
				.set({ totalCostUsd: '0' })
				.where(eq(sessions.id, ids.spent as string))

			expect(await releaseHeldSessions(deps())).toBe(RELEASE_BATCH)
			// normal1, normal2, normal3, normal4 (retry is normal) then the oldest low.
			expect((await releasedIds()).sort()).toEqual(
				['low1', 'normal1', 'normal2', 'normal3', 'normal4'].sort(),
			)

			// Their queue rows are due now; the rest still wait.
			expect((await queueRow(ids.normal1 as string))?.nextAttemptAt.getTime()).toBeLessThanOrEqual(
				Date.now() + 1000,
			)
			expect((await queueRow(ids.low2 as string))?.nextAttemptAt.getTime()).toBeGreaterThan(
				Date.now() + 60_000,
			)

			expect(await releaseHeldSessions(deps())).toBe(2)
			expect((await releasedIds()).length).toBe(7)
		})

		it('writes an admitted event with how long the session waited', async () => {
			await db
				.update(sessions)
				.set({ totalCostUsd: '0' })
				.where(eq(sessions.id, ids.spent as string))
			await releaseHeldSessions(deps())
			await new Promise((r) => setTimeout(r, 300))
			const written = await admissionEvents(ids.normal1 as string)
			expect(written.map((e) => (e.data as { decision: string }).decision)).toEqual([
				'deferred',
				'admitted',
			])
			expect(written[1]?.data).toMatchObject({ priority: 'normal' })
			expect(typeof (written[1]?.data as { held_for_ms?: number }).held_for_ms).toBe('number')
		})

		it('counts a released session against the start limit from then on', async () => {
			await db
				.update(sessions)
				.set({ totalCostUsd: '0' })
				.where(eq(sessions.id, ids.spent as string))
			expect(await manager.freeStartSlots(workspaceId)).toBe(10)
			await releaseHeldSessions(deps())
			expect(await manager.freeStartSlots(workspaceId)).toBe(10 - RELEASE_BATCH)
		})

		it('never lets go more than the free start slots', async () => {
			await db
				.update(sessions)
				.set({ totalCostUsd: '0' })
				.where(eq(sessions.id, ids.spent as string))
			expect(await releaseHeldSessions({ ...deps(), freeStartSlots: async () => 2 })).toBe(2)
			expect(await releaseHeldSessions({ ...deps(), freeStartSlots: async () => 0 })).toBe(0)
		})

		it('lets everything go when the target is removed', async () => {
			await setBudget(null)
			expect(await releaseHeldSessions(deps())).toBe(RELEASE_BATCH)
		})

		it('does not reset a queue row that was already claimed', async () => {
			const before = await queueRow(ids.low1 as string)
			await db
				.update(sessionDispatchAttempts)
				.set({ attempt: 1 })
				.where(eq(sessionDispatchAttempts.sessionId, ids.low1 as string))
			expect(await queue.makeDue(ids.low1 as string)).toBe(false)
			const after = await queueRow(ids.low1 as string)
			expect(after?.nextAttemptAt.getTime()).toBe(before?.nextAttemptAt.getTime())
		})
	})
})
