// The gate on work agents start for themselves: a cap in a row per reason and object, back-off when
// nothing changes, a daily token budget per agent, and a cap on triggers made by self-started runs.
// A session a person started always goes through.

import { events, notifications, triggers, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordEvent } from '../../lib/events/record-event'
import {
	type AdmitInput,
	BACKOFF_BASE_MS,
	MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS,
	SELF_START_LIMITS_KILLSWITCH_ENV_VAR,
	SessionNotAdmittedError,
	admitSessionStart,
	assertScheduledWorkWithinCap,
} from '../../services/self-start-limits'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertSession,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

const MINUTE = 60_000

describe('self-start limits', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let taskId: string
	let now: Date

	beforeEach(async () => {
		const human = await insertActor(db, { type: 'human' })
		humanId = human.id
		const ws = await insertWorkspace(db, humanId)
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Test agent' })
		agentId = agent.id
		await ensureWorkspaceMember(db, workspaceId, agentId)
		taskId = (await insertObject(db, workspaceId, humanId, { type: 'task', status: 'in_progress' }))
			.id
		now = new Date()
	})

	const admit = (over: Partial<AdmitInput> = {}, env: NodeJS.ProcessEnv = {}) =>
		admitSessionStart(
			db,
			{
				workspaceId,
				actorId: agentId,
				callerKind: 'trigger',
				hasChat: false,
				createdBy: humanId,
				initiatedFromObjectId: taskId,
				triggerType: 'reminder',
				...over,
			},
			env,
			now,
		)

	// A finished run by the agent on the task, `endedMinutesAgo` ago, lasting 10 minutes.
	const finishedRun = (
		endedMinutesAgo: number,
		reason: string,
		overrides?: Record<string, unknown>,
	) =>
		insertSession(db, workspaceId, agentId, humanId, {
			status: 'completed',
			config: { start_reason: reason },
			initiatedFromObjectId: taskId,
			startedAt: new Date(now.getTime() - (endedMinutesAgo + 10) * MINUTE),
			createdAt: new Date(now.getTime() - (endedMinutesAgo + 10) * MINUTE),
			completedAt: new Date(now.getTime() - endedMinutesAgo * MINUTE),
			...overrides,
		})

	const refusalOf = async (promise: Promise<unknown>) => {
		const err = await promise.then(
			() => null,
			(e) => e,
		)
		expect(err).toBeInstanceOf(SessionNotAdmittedError)
		return err as SessionNotAdmittedError
	}

	const admissionEvents = () =>
		db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, 'session_admission'),
					eq(events.entityId, agentId),
				),
			)

	const ownerCards = () =>
		db
			.select()
			.from(notifications)
			.where(
				and(eq(notifications.workspaceId, workspaceId), eq(notifications.targetActorId, humanId)),
			)

	const setSettings = async (patch: Record<string, unknown>) => {
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		await db
			.update(workspaces)
			.set({ settings: { ...(ws?.settings as object), ...patch } as never })
			.where(eq(workspaces.id, workspaceId))
	}

	describe('labels', () => {
		it('says why each start happened', async () => {
			expect((await admit()).reason).toBe('self_wakeup')
			expect((await admit({ triggerType: 'cron' })).reason).toBe('trigger_cron')
			expect(
				(await admit({ triggerType: undefined, callerKind: 'rest', createdBy: humanId })).reason,
			).toBe('person')
			expect(
				(await admit({ triggerType: undefined, callerKind: 'rest', createdBy: agentId })).reason,
			).toBe('agent_request')
		})
	})

	describe('cap of 2 automatic continuations in a row', () => {
		it('stops the 3rd restart in a row, leaves one note, and lets a person-started run through', async () => {
			await finishedRun(60, 'task_restart')
			await finishedRun(30, 'task_restart')

			const err = await refusalOf(
				admit({ triggerType: undefined, config: { task_restart: { attempt: 3 } } }),
			)
			expect(err.refusal).toBe('continuation_cap')
			expect(err.decision).toBe('blocked')

			// A second refusal for the same streak does not post a second note.
			await refusalOf(admit({ triggerType: undefined, config: { task_restart: { attempt: 3 } } }))
			const notes = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, taskId), eq(events.action, 'commented')))
			expect(notes).toHaveLength(1)
			expect((notes[0]?.data as { content: string }).content).toContain('Next step for a person')

			const audit = await admissionEvents()
			expect(
				audit.filter((e) => (e.data as { decision: string }).decision === 'blocked'),
			).toHaveLength(2)

			const person = await admit({ triggerType: undefined, callerKind: 'rest', createdBy: humanId })
			expect(person.reason).toBe('person')
		})

		it('lets a run through after a person-started one broke the streak', async () => {
			await finishedRun(90, 'task_restart')
			await finishedRun(60, 'task_restart')
			await finishedRun(30, 'person')

			const admitted = await admit({
				triggerType: undefined,
				config: { task_restart: { attempt: 1 } },
			})
			expect(admitted.reason).toBe('task_restart')
		})

		it('is switched off by the killswitch', async () => {
			await finishedRun(60, 'task_restart')
			await finishedRun(30, 'task_restart')
			const admitted = await admit(
				{ triggerType: undefined, config: { task_restart: { attempt: 3 } } },
				{ [SELF_START_LIMITS_KILLSWITCH_ENV_VAR]: '0' },
			)
			expect(admitted.reason).toBe('task_restart')
		})
	})

	describe('back-off when nothing changes', () => {
		it('holds a wake-up that comes too soon after 2 runs that changed nothing, then lets it through', async () => {
			await finishedRun(120, 'trigger_cron')
			await finishedRun(10, 'trigger_cron')

			const err = await refusalOf(admit({ triggerType: 'cron' }))
			expect(err.refusal).toBe('no_change_backoff')
			expect(err.decision).toBe('deferred')
			expect(err.retryAt?.getTime()).toBe(now.getTime() - 10 * MINUTE + BACKOFF_BASE_MS)

			now = new Date(now.getTime() + BACKOFF_BASE_MS)
			expect((await admit({ triggerType: 'cron' })).reason).toBe('trigger_cron')
		})

		it('does not count a run that changed something on the object', async () => {
			await finishedRun(120, 'trigger_cron')
			await finishedRun(10, 'trigger_cron')
			await recordEvent(db, {
				workspaceId,
				actorId: agentId,
				action: 'commented',
				entityType: 'object',
				entityId: taskId,
				data: { content: 'Moved it forward.' },
			})
			// The comment lands "now", after the last run ended, so it belongs to no run. Put one
			// inside the newest run instead.
			await db
				.update(events)
				.set({ createdAt: new Date(now.getTime() - 15 * MINUTE) })
				.where(and(eq(events.entityId, taskId), eq(events.action, 'commented')))

			expect((await admit({ triggerType: 'cron' })).reason).toBe('trigger_cron')
		})

		it('does not count a check the plan asked for', async () => {
			await finishedRun(120, 'trigger_cron')
			await finishedRun(10, 'trigger_cron', {
				config: { start_reason: 'trigger_cron', planned_check: true },
			})
			expect((await admit({ triggerType: 'cron' })).reason).toBe('trigger_cron')
		})

		it('after 3 quiet runs stops and asks a person once to extend, reassign or close', async () => {
			await finishedRun(300, 'trigger_cron')
			await finishedRun(200, 'trigger_cron')
			await finishedRun(100, 'trigger_cron')

			const err = await refusalOf(admit({ triggerType: 'cron' }))
			expect(err.refusal).toBe('no_change_decision')
			await refusalOf(admit({ triggerType: 'cron' }))

			const cards = await ownerCards()
			expect(cards).toHaveLength(1)
			expect(cards[0]?.title).toContain('Extend, reassign or close?')

			// A person asking for it is never held.
			const person = await admit({ triggerType: undefined, callerKind: 'rest', createdBy: humanId })
			expect(person.reason).toBe('person')
		})
	})

	describe('daily budget per agent for self-started runs', () => {
		const spend = (tokens: number, reason = 'trigger_cron') =>
			insertSession(db, workspaceId, agentId, humanId, {
				status: 'completed',
				config: { start_reason: reason },
				outputTokens: tokens,
				completedAt: new Date(),
			})

		it('does nothing while no amount is set', async () => {
			await spend(10_000_000)
			expect((await admit({ triggerType: 'cron', initiatedFromObjectId: null })).reason).toBe(
				'trigger_cron',
			)
		})

		it('skips the next self-started run at the limit, logs it and asks a person once', async () => {
			await setSettings({ agent_daily_budget: { per_agent: { [agentId]: 1000 } } })
			await spend(1200)

			const err = await refusalOf(admit({ triggerType: 'cron', initiatedFromObjectId: null }))
			expect(err.refusal).toBe('agent_daily_budget')
			await refusalOf(admit({ triggerType: 'cron', initiatedFromObjectId: null }))

			const refused = (await admissionEvents()).filter(
				(e) => (e.data as { refusal?: string }).refusal === 'agent_daily_budget',
			)
			expect(refused).toHaveLength(2)
			expect(refused[0]?.data).toMatchObject({
				decision: 'blocked',
				spent_tokens: 1200,
				limit_tokens: 1000,
			})
			const cards = await ownerCards()
			expect(cards).toHaveLength(1)
			expect(cards[0]?.title).toContain('hit its daily limit')
		})

		it('lets a run a person started go through at the limit', async () => {
			await setSettings({ agent_daily_budget: { per_agent: { [agentId]: 1000 } } })
			await spend(5000)
			const admitted = await admit({
				triggerType: undefined,
				callerKind: 'rest',
				createdBy: humanId,
				initiatedFromObjectId: null,
			})
			expect(admitted.reason).toBe('person')
		})

		it('does not count what a person started, or what another agent spent', async () => {
			await setSettings({ agent_daily_budget: { per_agent: { [agentId]: 1000 } } })
			await spend(5000, 'person')
			const other = await insertActor(db, { type: 'agent' })
			await insertSession(db, workspaceId, other.id, humanId, {
				status: 'completed',
				config: { start_reason: 'trigger_cron' },
				outputTokens: 5000,
				completedAt: new Date(),
			})
			expect((await admit({ triggerType: 'cron', initiatedFromObjectId: null })).reason).toBe(
				'trigger_cron',
			)
		})

		it('warns once at 80% and still admits', async () => {
			await setSettings({ agent_daily_budget: { default_tokens: 1000 } })
			await spend(850)

			expect((await admit({ triggerType: 'cron', initiatedFromObjectId: null })).reason).toBe(
				'trigger_cron',
			)
			await admit({ triggerType: 'cron', initiatedFromObjectId: null })

			const cards = await ownerCards()
			expect(cards).toHaveLength(1)
			expect(cards[0]?.title).toContain('near its daily limit')
		})
	})

	describe('scheduled work made by a self-started run', () => {
		const makeTrigger = async (sessionId: string, fromReason: string | null) => {
			const [row] = await db
				.insert(triggers)
				.values({
					workspaceId,
					name: 'Wake me',
					type: 'reminder',
					config: { scheduled_at: new Date(Date.now() + 3600_000).toISOString() },
					actionPrompt: 'check',
					targetActorId: agentId,
					enabled: true,
					createdBy: agentId,
				})
				.returning()
			await recordEvent(db, {
				workspaceId,
				actorId: agentId,
				action: 'created',
				entityType: 'trigger',
				entityId: row?.id as string,
				data: fromReason ? { created_from_start_reason: fromReason } : {},
			})
			return sessionId
		}

		it('allows a few, then refuses the next one', async () => {
			const run = await insertSession(db, workspaceId, agentId, humanId, {
				status: 'running',
				config: { start_reason: 'self_wakeup' },
			})
			for (let i = 0; i < MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS; i++) {
				const out = await assertScheduledWorkWithinCap(db, {
					workspaceId,
					actorId: agentId,
					sessionId: run.id,
				})
				expect(out.createdFromStartReason).toBe('self_wakeup')
				await makeTrigger(run.id, out.createdFromStartReason)
			}
			await expect(
				assertScheduledWorkWithinCap(db, { workspaceId, actorId: agentId, sessionId: run.id }),
			).rejects.toMatchObject({ status: 429 })
		})

		it('does not limit a run a person started or a call with no session', async () => {
			const run = await insertSession(db, workspaceId, agentId, humanId, {
				status: 'running',
				config: { start_reason: 'person' },
			})
			expect(
				await assertScheduledWorkWithinCap(db, {
					workspaceId,
					actorId: agentId,
					sessionId: run.id,
				}),
			).toEqual({ createdFromStartReason: null })
			expect(
				await assertScheduledWorkWithinCap(db, {
					workspaceId,
					actorId: agentId,
					sessionId: undefined,
				}),
			).toEqual({ createdFromStartReason: null })
		})
	})
})
