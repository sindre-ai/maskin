import { EventEmitter } from 'node:events'
import { events, conversations, messages, sessions } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReturnMessage, returnToSender } from '../../services/helper-return'
import { MENTION_GUARD_LIMITS } from '../../services/mention-guards'
import { configureSessionLifecycle, settleSession } from '../../services/session-lifecycle'
import type { SettleDependencies } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The helper return against real Postgres: the one-shot claim, the status read
// from the row, the skip rules, where the comment lands, and the round trip
// through CommentDispatcher that wakes the sender.

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

type Sess = Awaited<ReturnType<typeof insertSession>>

describe('Helper return (integration)', () => {
	let workspaceId: string
	let human: string
	let sender: { id: string; name: string }
	let helper: { id: string; name: string }
	let driver: { id: string }
	let objectId: string

	beforeEach(async () => {
		capturePosthogEvent.mockClear()
		human = getTestActorId()
		workspaceId = (await insertWorkspace(db, human)).id
		const mk = (name: string) =>
			insertActor(db, {
				type: 'agent',
				name,
				email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
			})
		;[sender, helper, driver] = await Promise.all([mk('Sender'), mk('Helper'), mk('Driver')])
		const object = await insertObject(db, workspaceId, human, {
			type: 'task',
			title: 'work',
			driver: driver.id,
		})
		objectId = object.id
	})

	/** A sender session that has finished (the usual case: it ended before the helper did). */
	const senderSession = (over?: Record<string, unknown>) =>
		insertSession(db, workspaceId, sender.id, sender.id, {
			status: 'completed',
			initiatedFromObjectId: objectId,
			...over,
		})

	const helperSession = (spawnedBy: Sess, over?: Record<string, unknown>) =>
		insertSession(db, workspaceId, helper.id, sender.id, {
			status: 'failed',
			spawnedBySessionId: spawnedBy.id,
			initiatedFromObjectId: objectId,
			result: { exit_code: 1 },
			...over,
		})

	const returnComments = () =>
		db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, objectId),
					eq(events.action, 'commented'),
					eq(events.actorId, helper.id),
				),
			)

	const skippedEvents = (sessionId: string) =>
		db
			.select({ data: events.data })
			.from(events)
			.where(and(eq(events.entityId, sessionId), eq(events.action, 'helper_return_skipped')))

	it('a failed helper posts one comment as the helper, mentioning the sender, with options and no author session id', async () => {
		const s = await senderSession()
		const h = await helperSession(s, {
			result: { exit_code: 1, error: 'Container exited with code 1' },
		})

		const out = await returnToSender(db, h.id)

		expect(out).toEqual({ returned: true, destination: 'object' })
		const rows = await returnComments()
		expect(rows).toHaveLength(1)
		const data = rows[0].data as {
			content: string
			mentions: string[]
			metadata: { helper_return: string }
			authorSessionId?: string
			attention: number
		}
		expect(data.mentions).toEqual([sender.id])
		expect(data.metadata.helper_return).toBe(h.id)
		// Condition 2: nothing that would link the session this wakes.
		expect(data.authorSessionId).toBeUndefined()
		expect(JSON.stringify(data)).not.toContain(s.id)
		expect(data.content).toContain('Helper stopped with an error')
		expect(data.content).toContain('retry with a narrower task')
		expect(data.content).toContain('> Container exited with code 1')
		expect(data.content).not.toContain('`')
		expect(data.attention).toBe(2)
	})

	it('a timeout says it ran out of time', async () => {
		const s = await senderSession()
		const h = await helperSession(s, { status: 'timeout', result: { exit_code: null } })
		await returnToSender(db, h.id)
		const [row] = await returnComments()
		expect((row.data as { content: string }).content).toContain('Helper ran out of time')
	})

	it('a completed create_session helper returns, with attention 1 and no retry advice', async () => {
		const s = await senderSession()
		const h = await helperSession(s, { status: 'completed', result: { exit_code: 0 } })
		await returnToSender(db, h.id)
		const [row] = await returnComments()
		const data = row.data as { content: string; attention: number }
		expect(data.content).toContain('Helper finished the work you handed it')
		expect(data.content).not.toContain('retry')
		expect(data.attention).toBe(1)
	})

	it('a person’s stop (stored as failed with user_stop_requested) reads as a stop, not a failure', async () => {
		const s = await senderSession()
		const h = await helperSession(s, {
			status: 'failed',
			result: { exit_code: 143, user_stop_requested: true },
		})
		await returnToSender(db, h.id)
		const [row] = await returnComments()
		const content = (row.data as { content: string }).content
		expect(content).toContain('A person stopped Helper')
		expect(content).not.toContain('retry')
	})

	it('a double call posts once', async () => {
		const s = await senderSession()
		const h = await helperSession(s)
		const [a, b] = await Promise.all([returnToSender(db, h.id), returnToSender(db, h.id)])
		await returnToSender(db, h.id)
		expect([a.returned, b.returned].filter(Boolean)).toHaveLength(1)
		expect(await returnComments()).toHaveLength(1)
	})

	it('does nothing for a session with no link, and does not take the claim', async () => {
		const h = await insertSession(db, workspaceId, helper.id, human, { status: 'failed' })
		expect(await returnToSender(db, h.id)).toEqual({ returned: false, reason: 'no_link' })
		expect(await returnComments()).toHaveLength(0)
	})

	it('does not claim or post for a helper that has not finished', async () => {
		const s = await senderSession()
		const h = await helperSession(s, { status: 'running' })
		expect(await returnToSender(db, h.id)).toEqual({ returned: false, reason: 'no_link' })
		const [row] = await db.select().from(sessions).where(eq(sessions.id, h.id))
		expect(row.helperReturnedAt).toBeNull()
		// Once it does finish, the return still goes out.
		await db.update(sessions).set({ status: 'timeout' }).where(eq(sessions.id, h.id))
		expect((await returnToSender(db, h.id)).returned).toBe(true)
	})

	it('says what the helper’s own row says', async () => {
		const s = await senderSession()
		const h = await helperSession(s, { status: 'timeout' })
		await returnToSender(db, h.id)
		const [row] = await returnComments()
		expect((row.data as { content: string }).content).toContain('ran out of time')
	})

	it('skips when the sender is still live, and records why', async () => {
		const s = await senderSession({ status: 'running' })
		const h = await helperSession(s)
		expect(await returnToSender(db, h.id)).toEqual({ returned: false, reason: 'sender_live' })
		expect(await returnComments()).toHaveLength(0)
		expect((await skippedEvents(h.id)).map((e) => e.data)).toEqual([{ reason: 'sender_live' }])
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'helper_return_skipped',
			helper.id,
			expect.objectContaining({ reason: 'sender_live' }),
		)
	})

	it('a completed mention-spawned helper does not return; a failed one does', async () => {
		const s = await senderSession()
		const mentionCfg = {
			trigger_source: 'comment_fallback',
			mention: { object_id: objectId, commenter_actor_id: sender.id, comment_event_id: 1 },
		}
		const done = await helperSession(s, {
			status: 'completed',
			result: { exit_code: 0 },
			config: mentionCfg,
		})
		expect(await returnToSender(db, done.id)).toEqual({
			returned: false,
			reason: 'mention_reply_is_the_return',
		})
		const failed = await helperSession(s, { status: 'failed', config: mentionCfg })
		expect((await returnToSender(db, failed.id)).returned).toBe(true)
		expect(await returnComments()).toHaveLength(1)
	})

	describe('where it lands', () => {
		it('falls back to the sender’s object when the helper has none', async () => {
			const s = await senderSession()
			const h = await helperSession(s, { initiatedFromObjectId: null })
			expect((await returnToSender(db, h.id)).returned).toBe(true)
			expect(await returnComments()).toHaveLength(1)
		})

		it('falls back to the sender’s conversation when neither has an object', async () => {
			const [conv] = await db
				.insert(conversations)
				.values({ workspaceId, createdBy: human, title: 'chat' })
				.returning()
			const s = await senderSession({ initiatedFromObjectId: null, conversationId: conv.id })
			const h = await helperSession(s, { initiatedFromObjectId: null })
			const out = await returnToSender(db, h.id)
			expect(out).toEqual({ returned: true, destination: 'conversation' })
			const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id))
			expect(msgs).toHaveLength(1)
			expect(msgs[0].actorId).toBe(helper.id)
			expect(msgs[0].content).toContain('Helper stopped with an error')
		})

		it('with no destination it posts nothing and records no_destination', async () => {
			const s = await senderSession({ initiatedFromObjectId: null })
			const h = await helperSession(s, { initiatedFromObjectId: null })
			expect(await returnToSender(db, h.id)).toEqual({ returned: false, reason: 'no_destination' })
			expect(await returnComments()).toHaveLength(0)
			expect((await skippedEvents(h.id)).map((e) => e.data)).toEqual([{ reason: 'no_destination' }])
		})
	})

	it('stops at the ceiling of returns to one sender on one object', async () => {
		for (let i = 0; i < MENTION_GUARD_LIMITS.maxReturnsPerWindow; i++) {
			await insertSession(db, workspaceId, sender.id, helper.id, {
				status: 'completed',
				initiatedFromObjectId: objectId,
				config: { trigger_source: 'comment_fallback', mention: { helper_return: true } },
			})
		}
		const s = await senderSession()
		const h = await helperSession(s)
		expect(await returnToSender(db, h.id)).toEqual({ returned: false, reason: 'return_cap' })
		expect(await returnComments()).toHaveLength(0)
	})

	describe('settleSession', () => {
		const deps = (): SettleDependencies => ({
			db,
			stopSandbox: async () => 'local',
			pushAgentFiles: async () => 'ok',
		})

		it('a helper past its wall timeout sends one timeout return', async () => {
			const s = await senderSession()
			const h = await helperSession(s, { status: 'running', result: null })
			await settleSession(
				h.id,
				{ kind: 'timeout', classification: 'wall_timeout', source: 'timeout-watchdog' },
				deps(),
			)
			await vi.waitFor(async () => expect(await returnComments()).toHaveLength(1), {
				timeout: 5_000,
				interval: 50,
			})
			const [row] = await returnComments()
			expect((row.data as { content: string }).content).toContain('ran out of time')
		})

		it('a pause is not an ending: nothing is sent and the claim stays open', async () => {
			const s = await senderSession()
			const h = await helperSession(s, { status: 'running', result: null })
			await settleSession(
				h.id,
				{
					kind: 'pause',
					classification: 'idle_timeout',
					source: 'sandbox-exit',
					snapshotKey: 's3://x',
				},
				deps(),
			)
			await new Promise((r) => setTimeout(r, 300))
			expect(await returnComments()).toHaveLength(0)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, h.id))
			expect(row.helperReturnedAt).toBeNull()
		})
	})

	describe('round trip through CommentDispatcher', () => {
		let bridge: EventEmitter & PgNotifyBridge
		let dispatcher: CommentDispatcher
		let woken: Array<{ actorId: string }>

		beforeEach(() => {
			woken = []
			bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
			const sm = {
				enqueueSession: vi.fn(),
				createSession: vi.fn(async (ws: string, params: Record<string, unknown>) => {
					const row = await insertSession(
						db,
						ws,
						params.actorId as string,
						params.createdBy as string,
						{
							status: 'completed',
							config: {
								...((params.config as object) ?? {}),
								trigger_source: params.triggerSource,
							},
							spawnedBySessionId: params.spawnedBySessionId ?? null,
							initiatedFromObjectId: params.initiatedFromObjectId ?? null,
						},
					)
					woken.push({ actorId: params.actorId as string })
					return row
				}),
				stopSession: vi.fn(),
				on: vi.fn(),
				off: vi.fn(),
			}
			configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
			dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
			dispatcher.start()
		})

		afterEach(() => dispatcher.stop())

		it('wakes exactly one session, on the sender, with no link; the driver is not also woken', async () => {
			const s = await senderSession()
			const h = await helperSession(s, { config: { hop_depth: 2 } })
			await returnToSender(db, h.id)
			const [comment] = await returnComments()
			bridge.emit('event', {
				workspace_id: workspaceId,
				actor_id: helper.id,
				action: 'commented',
				entity_type: 'object',
				entity_id: objectId,
				event_id: String(comment.id),
			} satisfies PgEvent)
			await new Promise((r) => setTimeout(r, 400))

			expect(woken).toEqual([{ actorId: sender.id }])
			const wokenRow = (
				await db.select().from(sessions).where(eq(sessions.actorId, sender.id))
			).find((r) => r.id !== s.id)
			expect(wokenRow).toBeDefined()
			expect(wokenRow?.spawnedBySessionId).toBeNull()
			expect((wokenRow?.config as { hop_depth?: number }).hop_depth).toBe(2)
			expect(
				(wokenRow?.config as { mention?: { helper_return?: boolean } }).mention?.helper_return,
			).toBe(true)
		})
	})
})

describe('buildReturnMessage', () => {
	it('never contains a backtick, and quotes any recorded reason', () => {
		for (const kind of ['completed', 'failed', 'timeout', 'user_stopped'] as const) {
			const text = buildReturnMessage({
				kind,
				helperName: 'Helper',
				sessionUrl: 'https://maskin.io/x',
				reason: 'it broke',
			})
			expect(text).not.toContain('`')
			if (kind === 'failed' || kind === 'timeout') expect(text).toContain('> it broke')
		}
	})
})
