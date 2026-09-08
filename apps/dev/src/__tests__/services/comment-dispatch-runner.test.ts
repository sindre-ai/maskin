import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import {
	COMMENT_FALLBACK_TRIGGER_SOURCE,
	CommentDispatchRunner,
} from '../../services/trigger-runner'
import { createMockSessionManager, createTestContext } from '../setup'

/**
 * A commented-event PG NOTIFY frame, mirroring what the bridge emits from the
 * events table (data.mentions / data.parentEventId are the load-bearing bits
 * the subscriber reads from the events row it rehydrates).
 */
function buildCommentEvent(overrides: Partial<PgEvent> = {}): PgEvent {
	return {
		workspace_id: 'ws-1',
		actor_id: 'commenter-1',
		action: 'commented',
		entity_type: 'object',
		entity_id: 'obj-1',
		event_id: '42',
		...overrides,
	}
}

/**
 * Wait one macro-task so the fire-and-forget catch chain inside
 * `start()`'s event-handler wrapper resolves before assertions run. The
 * subscriber intentionally never awaits its own async pipeline (matches the
 * pre-move route-level behaviour) so the tests need this tick.
 */
async function flush() {
	await new Promise((r) => setTimeout(r, 0))
}

describe('CommentDispatchRunner', () => {
	let runner: CommentDispatchRunner
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: Record<string, unknown>

	beforeEach(() => {
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		runner = new CommentDispatchRunner(ctx.db, bridge, sessionManager)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
		})
	})

	afterEach(async () => {
		await runner.stop()
		vi.restoreAllMocks()
	})

	describe('start/stop lifecycle', () => {
		it('registers a listener on bridge start and removes it on stop', async () => {
			await runner.start()
			expect(bridge.listenerCount('event')).toBe(1)
			await runner.stop()
			expect(bridge.listenerCount('event')).toBe(0)
		})

		it('is idempotent — calling start twice does not double-subscribe', async () => {
			await runner.start()
			await runner.start()
			expect(bridge.listenerCount('event')).toBe(1)
		})
	})

	describe('dispatch matcher', () => {
		it('ignores events with non-commented actions', async () => {
			mockResults.selectQueue = [[{ id: 42 }]] // would-be event row lookup
			await runner.start()
			bridge.emit('event', buildCommentEvent({ action: 'updated' }))
			await flush()
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('ignores commented events on non-object entity types', async () => {
			await runner.start()
			bridge.emit('event', buildCommentEvent({ entity_type: 'session' }))
			await flush()
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('short-circuits when the event row cannot be rehydrated', async () => {
			mockResults.selectQueue = [[]] // events lookup returns nothing
			await runner.start()
			bridge.emit('event', buildCommentEvent())
			await flush()
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('case 1a — agent mention', () => {
		it('enqueues a session for a mentioned agent with comment_fallback trigger source', async () => {
			mockResults.selectQueue = [
				// 1) events lookup for comment_event_id=42
				[
					{
						id: 42,
						workspaceId: 'ws-1',
						actorId: 'commenter-1',
						entityId: 'obj-1',
						data: {
							mentions: ['agent-1'],
							content: 'hey @agent, please look at this',
						},
					},
				],
				// 2) actors lookup for [agent-1]
				[{ id: 'agent-1', type: 'agent' }],
				// 3) notifications lookup (source_comment_event_id=42) — the transactional
				//    postComment write already inserted the needs_input row.
				[{ id: 'notif-abc', targetActorId: 'agent-1' }],
			]
			const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
			await runner.start()
			bridge.emit('event', buildCommentEvent())
			await flush()

			expect(sessionManager.createSession).toHaveBeenCalledOnce()
			const [wsArg, paramsArg] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(wsArg).toBe('ws-1')
			expect(paramsArg).toMatchObject({
				actorId: 'agent-1',
				triggerSource: COMMENT_FALLBACK_TRIGGER_SOURCE,
				sourceCommentEventId: 42,
				createdBy: 'commenter-1',
				config: {
					mention: {
						object_id: 'obj-1',
						commenter_actor_id: 'commenter-1',
						notification_id: 'notif-abc',
						comment_event_id: 42,
					},
				},
			})
			expect(paramsArg.actionPrompt).toContain('notif-abc')
			expect(paramsArg.actionPrompt).toContain('obj-1')

			expect(logSpy).toHaveBeenCalledWith(
				'Comment dispatch resolved',
				expect.objectContaining({
					event_id: 42,
					case: 'case_1_mention',
					resolved_actor_id: 'agent-1',
				}),
			)
		})

		it('spawns one session per unique mention when a comment @-mentions several agents', async () => {
			mockResults.selectQueue = [
				[
					{
						id: 42,
						workspaceId: 'ws-1',
						actorId: 'commenter-1',
						entityId: 'obj-1',
						data: {
							// Duplicate ids collapse: the subscriber must not double-fire on
							// a repeat of the same mention id inside one comment.
							mentions: ['agent-1', 'agent-2', 'agent-1'],
							content: 'multi mention',
						},
					},
				],
				[
					{ id: 'agent-1', type: 'agent' },
					{ id: 'agent-2', type: 'agent' },
				],
				[
					{ id: 'notif-a', targetActorId: 'agent-1' },
					{ id: 'notif-b', targetActorId: 'agent-2' },
				],
			]
			await runner.start()
			bridge.emit('event', buildCommentEvent())
			await flush()

			expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
			const calls = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls.map(
				([, p]) => p.actorId,
			)
			expect(calls.sort()).toEqual(['agent-1', 'agent-2'])
		})
	})

	describe('case 1a — human mention', () => {
		it('does not spawn a session for a mentioned human, but still emits the case_1_mention log', async () => {
			mockResults.selectQueue = [
				[
					{
						id: 42,
						workspaceId: 'ws-1',
						actorId: 'commenter-1',
						entityId: 'obj-1',
						data: {
							mentions: ['human-1'],
							content: 'hey @person',
						},
					},
				],
				[{ id: 'human-1', type: 'human' }],
				[], // no notifications for humans
			]
			const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
			await runner.start()
			bridge.emit('event', buildCommentEvent())
			await flush()

			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(logSpy).toHaveBeenCalledWith(
				'Comment dispatch resolved',
				expect.objectContaining({
					event_id: 42,
					case: 'case_1_mention',
					resolved_actor_id: 'human-1',
				}),
			)
		})
	})

	describe('self-authored no-op', () => {
		it('suppresses dispatch and logs noop_self_authored when the mentioned actor authored the parent comment', async () => {
			mockResults.selectQueue = [
				[
					{
						id: 43,
						workspaceId: 'ws-1',
						actorId: 'human-1',
						entityId: 'obj-1',
						data: {
							mentions: ['agent-1'],
							parentEventId: 40,
							content: 'follow up',
						},
					},
				],
				// actors lookup — agent-1 is an agent
				[{ id: 'agent-1', type: 'agent' }],
				// parent comment lookup — agent-1 authored the parent
				[{ actorId: 'agent-1' }],
				// notifications lookup — none because the subscriber shouldn't need one
				[],
			]
			const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
			await runner.start()
			bridge.emit('event', buildCommentEvent({ actor_id: 'human-1', event_id: '43' }))
			await flush()

			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(logSpy).toHaveBeenCalledWith(
				'Comment dispatch resolved',
				expect.objectContaining({
					event_id: 43,
					case: 'noop_self_authored',
					resolved_actor_id: 'agent-1',
				}),
			)
		})
	})

	describe('metadata suppress flag', () => {
		it('short-circuits when the comment metadata carries suppress_auto_dispatch', async () => {
			// Signup-welcome sets this flag when it spawns its own bespoke research
			// prompt. The subscriber must not race a second, generically-prompted
			// session against the caller's explicit one.
			mockResults.selectQueue = [
				[
					{
						id: 44,
						workspaceId: 'ws-1',
						actorId: 'commenter-1',
						entityId: 'obj-1',
						data: {
							mentions: ['agent-1'],
							content: 'flagged',
							metadata: { suppress_auto_dispatch: true },
						},
					},
				],
			]
			await runner.start()
			bridge.emit('event', buildCommentEvent({ event_id: '44' }))
			await flush()

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('mentions with no matching actor', () => {
		it('drops unresolved mention ids without spawning or logging a resolved case', async () => {
			mockResults.selectQueue = [
				[
					{
						id: 42,
						workspaceId: 'ws-1',
						actorId: 'commenter-1',
						entityId: 'obj-1',
						data: {
							mentions: ['dangling-id'],
							content: 'typo mention',
						},
					},
				],
				[], // no actors match
				[], // no notifications
			]
			const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
			await runner.start()
			bridge.emit('event', buildCommentEvent())
			await flush()

			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(logSpy).not.toHaveBeenCalledWith(
				'Comment dispatch resolved',
				expect.objectContaining({ case: 'case_1_mention' }),
			)
		})
	})
})
