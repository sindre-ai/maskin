import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { vi } from 'vitest'
import { CommentDispatcher } from '../../services/trigger-runner'
import { buildActor, buildNotification } from '../factories'
import { createMockSessionManager, createTestContext } from '../setup'

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

	it('empty mentions array → no dispatch (Task 2 handles cases 2/3)', async () => {
		mockResults.selectQueue = [[{ actorId: 'commenter-1', data: { mentions: [], content: 'x' } }]]
		dispatcher.start()
		await fire(baseEvent())
		expect(sessionManager.createSession).not.toHaveBeenCalled()
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
