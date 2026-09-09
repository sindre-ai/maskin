import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { vi } from 'vitest'
import { trackCommentResponderResolved } from '../../lib/analytics/comment-responder-events'
import {
	CommentDispatcher,
	normalizeMentionsList,
	normalizeParentEventId,
} from '../../services/trigger-runner'
import { buildActor, buildNotification } from '../factories'
import { createMockSessionManager, createTestContext } from '../setup'

vi.mock('../../lib/analytics/comment-responder-events', () => ({
	trackCommentResponderResolved: vi.fn().mockResolvedValue(undefined),
}))

const COS_ACTOR_ID = '2e772113-48d0-410d-82e6-2414881581fc'

describe('CommentDispatcher', () => {
	let dispatcher: CommentDispatcher
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: Record<string, unknown>
	let calls: { inserts: unknown[]; updates: unknown[] }
	let logInfo: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		const { logger } = await import('../../lib/logger')
		logInfo = vi.spyOn(logger, 'info').mockImplementation(() => logger)
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		calls = ctx.calls
		dispatcher = new CommentDispatcher(ctx.db, bridge, sessionManager)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
		})
		vi.mocked(trackCommentResponderResolved).mockClear()
	})

	afterEach(() => {
		dispatcher.stop()
		vi.restoreAllMocks()
	})

	function baseEvent(overrides?: Partial<PgEvent>): PgEvent {
		return {
			workspace_id: 'ws-1',
			entity_type: 'object',
			entity_id: 'a4f1c9d2-3b58-4e07-9c26-8f5d0a7b1e43',
			action: 'commented',
			actor_id: 'commenter-1',
			event_id: '42',
			...overrides,
		}
	}

	async function fire(event: PgEvent) {
		bridge.emit('event', event)
		// Yield enough microtask ticks to drain every await inside
		// handleEvent → dispatchMention → insertNotificationsWithEvents. Each
		// mock resolves synchronously, so a small loop is plenty.
		for (let i = 0; i < 20; i++) await Promise.resolve()
	}

	it('ignores events that are not commented-on-object', async () => {
		dispatcher.start()
		await fire(baseEvent({ action: 'created' }))
		await fire(baseEvent({ entity_type: 'session' }))
		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})

	it('agent-actor mention → session enqueued with comment_fallback attribution', async () => {
		const agent = buildActor({ type: 'agent' })
		const notification = buildNotification({
			targetActorId: agent.id,
			sourceActorId: 'commenter-1',
			type: 'needs_input',
		})
		mockResults.selectQueue = [
			// event row lookup
			[{ actorId: 'commenter-1', data: { content: 'Please look', mentions: [agent.id] } }],
			// mentioned-actor lookup
			[{ id: agent.id, type: agent.type }],
		]
		// The transactional notification insert returns a row.
		mockResults.insert = [notification]

		dispatcher.start()
		await fire(baseEvent())

		expect(sessionManager.createSession).toHaveBeenCalledOnce()
		const [wsId, params] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>]
		expect(wsId).toBe('ws-1')
		expect(params.actorId).toBe(agent.id)
		expect(params.triggerSource).toBe('comment_fallback')
		expect(params.sourceCommentEventId).toBe(42)
		const config = params.config as { mention: { comment_event_id: number } }
		expect(config.mention.comment_event_id).toBe(42)
		expect((params.actionPrompt as string).includes(notification.id)).toBe(true)

		const dispatchLog = logInfo.mock.calls.find((c) => c[0] === 'Comment dispatch')
		expect(dispatchLog?.[1]).toMatchObject({
			event_id: '42',
			case: 'case_1_mention',
			resolved_actor_id: agent.id,
		})
	})

	it('human-actor mention → notification sent, no session', async () => {
		const human = buildActor({ type: 'human' })
		const notification = buildNotification({
			targetActorId: human.id,
			sourceActorId: 'commenter-1',
		})
		mockResults.selectQueue = [
			[{ actorId: 'commenter-1', data: { mentions: [human.id], content: 'ping' } }],
			[{ id: human.id, type: human.type }],
		]
		mockResults.insert = [notification]

		dispatcher.start()
		await fire(baseEvent())

		expect(sessionManager.createSession).not.toHaveBeenCalled()
		// One notification row + one audit event row for it.
		const notificationInsert = calls.inserts.find((v) => {
			const rows = Array.isArray(v) ? v : [v]
			return rows.some((r) => (r as { targetActorId?: string })?.targetActorId === human.id)
		})
		expect(notificationInsert).toBeDefined()
	})

	it('multi-mention: one dispatch per mentioned actor', async () => {
		const agentA = buildActor({ type: 'agent' })
		const agentB = buildActor({ type: 'agent' })
		const nA = buildNotification({ targetActorId: agentA.id })
		const nB = buildNotification({ targetActorId: agentB.id })
		mockResults.selectQueue = [
			[
				{
					actorId: 'commenter-1',
					data: { mentions: [agentA.id, agentB.id], content: 'hey both' },
				},
			],
			[
				{ id: agentA.id, type: agentA.type },
				{ id: agentB.id, type: agentB.type },
			],
		]
		// Each dispatchMention runs one insert transaction that returns a row.
		mockResults.insertQueue = [[nA], [], [nB], []]

		dispatcher.start()
		await fire(baseEvent())

		expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
		const dispatchedActors = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls
			.map((c) => (c[1] as { actorId: string }).actorId)
			.sort()
		expect(dispatchedActors).toEqual([agentA.id, agentB.id].sort())
	})

	it('mentioned actor authored the parent comment → suppressed with noop_self_authored', async () => {
		const agent = buildActor({ type: 'agent' })
		mockResults.selectQueue = [
			// event lookup for the reply
			[
				{
					actorId: 'commenter-1',
					data: { mentions: [agent.id], parentEventId: 7, content: 'reply' },
				},
			],
			// parent-author lookup
			[{ actorId: agent.id }],
			// mentioned-actor lookup
			[{ id: agent.id, type: agent.type }],
		]

		dispatcher.start()
		await fire(baseEvent())

		expect(sessionManager.createSession).not.toHaveBeenCalled()
		const noopLog = logInfo.mock.calls.find(
			(c) =>
				c[0] === 'Comment dispatch' && (c[1] as { case?: string })?.case === 'noop_self_authored',
		)
		expect(noopLog?.[1]).toMatchObject({
			event_id: '42',
			case: 'noop_self_authored',
			resolved_actor_id: agent.id,
		})
	})

	it('dispatches to the driver with triggerSource and sourceCommentEventId when driver ≠ author (case 2)', async () => {
		mockResults.selectQueue = [
			// event data
			[{ actorId: 'human-author', data: { content: 'hi', mentions: [] } }],
			// driver lookup
			[{ driver: 'driver-1' }],
		]

		dispatcher.start()
		await fire(baseEvent({ actor_id: 'human-author' }))

		expect(sessionManager.createSession).toHaveBeenCalledOnce()
		const [wsId, opts] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>]
		expect(wsId).toBe('ws-1')
		expect(opts.actorId).toBe('driver-1')
		expect(opts.triggerSource).toBe('comment_fallback')
		expect(opts.sourceCommentEventId).toBe(42)
		expect(opts.actionPrompt as string).not.toContain('There is no driver')

		expect(vi.mocked(trackCommentResponderResolved)).toHaveBeenCalledWith(
			expect.objectContaining({
				case: 'case_2_driver_fallback',
				resolvedActorId: 'driver-1',
				sourceCommentEventId: 42,
			}),
		)
	})

	it('falls through to CoS (case 3) when driver = author', async () => {
		mockResults.selectQueue = [
			// event data — author is 'human-author'
			[{ actorId: 'human-author', data: { content: 'hi', mentions: [] } }],
			// driver lookup — driver IS the author
			[{ driver: 'human-author' }],
			// CoS routing prompt: objects.title lookup
			[{ title: 'A bet' }],
		]

		dispatcher.start()
		await fire(baseEvent({ actor_id: 'human-author' }))

		expect(sessionManager.createSession).toHaveBeenCalledOnce()
		const [, opts] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			Record<string, unknown>,
		]
		expect(opts.actorId).toBe(COS_ACTOR_ID)
		expect(opts.actionPrompt as string).toContain('There is no driver')

		expect(vi.mocked(trackCommentResponderResolved)).toHaveBeenCalledWith(
			expect.objectContaining({ case: 'case_3_cos_fallback', resolvedActorId: COS_ACTOR_ID }),
		)
	})

	it('dispatches to CoS when driver is null (case 3)', async () => {
		mockResults.selectQueue = [
			[{ actorId: 'human-author', data: { content: 'ping', mentions: [] } }],
			// driver lookup — no driver
			[{ driver: null }],
			// CoS routing prompt: title lookup
			[{ title: 'Orphan bet' }],
		]

		dispatcher.start()
		await fire(baseEvent({ actor_id: 'human-author' }))

		expect(sessionManager.createSession).toHaveBeenCalledOnce()
		const [, opts] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			Record<string, unknown>,
		]
		expect(opts.actorId).toBe(COS_ACTOR_ID)
		expect(opts.triggerSource).toBe('comment_fallback')
		expect(opts.sourceCommentEventId).toBe(42)

		expect(vi.mocked(trackCommentResponderResolved)).toHaveBeenCalledWith(
			expect.objectContaining({ case: 'case_3_cos_fallback', resolvedActorId: COS_ACTOR_ID }),
		)
	})

	it('suppresses dispatch when the driver authored the parent comment (loop-safety option a)', async () => {
		mockResults.selectQueue = [
			// event data — has parentEventId, no mentions
			[
				{
					actorId: 'human-author',
					data: { content: 'reply', mentions: [], parentEventId: 8000 },
				},
			],
			// parent-author lookup — the driver authored the parent
			[{ actorId: 'driver-1' }],
			// driver lookup
			[{ driver: 'driver-1' }],
			// CoS routing prompt (fell through to case 3): title lookup
			[{ title: 'Some object' }],
		]

		dispatcher.start()
		await fire(baseEvent({ actor_id: 'human-author' }))

		// Driver would loop back on themselves via case 2 → fall through to
		// case 3, which dispatches to CoS. Verify we did NOT dispatch to the
		// driver.
		const dispatchedTo = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => (c[1] as { actorId: string }).actorId,
		)
		expect(dispatchedTo).not.toContain('driver-1')
		expect(dispatchedTo).toContain(COS_ACTOR_ID)
	})

	it('logs noop_self_authored when the only fallback target authored the comment (no dispatch)', async () => {
		mockResults.selectQueue = [
			// event data — author is CoS, no mentions
			[{ actorId: COS_ACTOR_ID, data: { content: 'hi', mentions: [] } }],
			// driver lookup — no driver, so we fall to case 3
			[{ driver: null }],
		]

		// Author IS the CoS
		dispatcher.start()
		await fire(baseEvent({ actor_id: COS_ACTOR_ID }))

		expect(sessionManager.createSession).not.toHaveBeenCalled()
		expect(vi.mocked(trackCommentResponderResolved)).toHaveBeenCalledWith(
			expect.objectContaining({ case: 'noop_self_authored', resolvedActorId: null }),
		)
	})

	it('emits case_1_mention on the mention path via comment_responder_resolved', async () => {
		const agent = buildActor({ type: 'agent' })
		const notification = buildNotification({ targetActorId: agent.id })
		mockResults.selectQueue = [
			[{ actorId: 'commenter-1', data: { content: 'hi', mentions: [agent.id] } }],
			[{ id: agent.id, type: agent.type }],
		]
		mockResults.insert = [notification]

		dispatcher.start()
		await fire(baseEvent())

		expect(vi.mocked(trackCommentResponderResolved)).toHaveBeenCalledWith(
			expect.objectContaining({ case: 'case_1_mention', sourceCommentEventId: 42 }),
		)
	})

	it('short-circuits with noop_suppressed when data.metadata.suppress_auto_dispatch is true', async () => {
		// Bespoke-dispatch escape hatch: a caller can stamp this flag on the
		// comment to prevent the resolver from double-dispatching a generic
		// case-2/case-3 session. Fires BEFORE the mention / case-2 / case-3
		// branches so no downstream logic runs.
		mockResults.selectQueue = [
			[
				{
					actorId: 'commenter-1',
					data: {
						content: 'welcome',
						mentions: [],
						metadata: { suppress_auto_dispatch: true },
					},
				},
			],
		]

		dispatcher.start()
		await fire(baseEvent())

		expect(sessionManager.createSession).not.toHaveBeenCalled()
		expect(vi.mocked(trackCommentResponderResolved)).toHaveBeenCalledWith(
			expect.objectContaining({
				case: 'noop_suppressed',
				resolvedActorId: null,
				sourceCommentEventId: 42,
			}),
		)
	})

	it('start() is idempotent — one bridge listener regardless of repeat calls', () => {
		dispatcher.start()
		dispatcher.start()
		expect(bridge.listenerCount('event')).toBe(1)
	})

	it('stop() removes the bridge listener', () => {
		dispatcher.start()
		expect(bridge.listenerCount('event')).toBe(1)
		dispatcher.stop()
		expect(bridge.listenerCount('event')).toBe(0)
	})
})

describe('normalizeMentionsList()', () => {
	it('accepts a string array', () => {
		expect(normalizeMentionsList(['a', 'b'])).toEqual(['a', 'b'])
	})

	it('drops non-string and empty entries', () => {
		expect(normalizeMentionsList(['a', '', null, 42, 'b'])).toEqual(['a', 'b'])
	})

	it('returns empty on non-array input', () => {
		expect(normalizeMentionsList(null)).toEqual([])
		expect(normalizeMentionsList(undefined)).toEqual([])
		expect(normalizeMentionsList('mention')).toEqual([])
	})
})

describe('normalizeParentEventId()', () => {
	it('accepts positive numbers', () => {
		expect(normalizeParentEventId(42)).toBe(42)
	})

	it('accepts numeric strings', () => {
		expect(normalizeParentEventId('42')).toBe(42)
	})

	it('rejects invalid values', () => {
		expect(normalizeParentEventId(0)).toBeNull()
		expect(normalizeParentEventId(-1)).toBeNull()
		expect(normalizeParentEventId('abc')).toBeNull()
		expect(normalizeParentEventId(null)).toBeNull()
		expect(normalizeParentEventId(undefined)).toBeNull()
		expect(normalizeParentEventId(Number.NaN)).toBeNull()
		expect(normalizeParentEventId(Number.POSITIVE_INFINITY)).toBeNull()
	})
})
