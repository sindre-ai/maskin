import { queryKeys } from '@/lib/query-keys'
import { invalidateFromSSE } from '@/lib/sse-invalidation'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackTriggerFired: vi.fn(),
	trackAgentSessionCompleted: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
	api: {
		sessions: { get: vi.fn() },
	},
}))

import { trackAgentSessionCompleted, trackTriggerFired } from '@/lib/analytics'
import { api } from '@/lib/api'

function createMockQueryClient() {
	return {
		invalidateQueries: vi.fn(),
	}
}

const workspaceId = 'ws-1'
const entityId = 'entity-1'

beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
})

afterEach(() => {
	// Session events open a module-level coalescing window; flush it so it
	// can't leak into the next test.
	vi.runOnlyPendingTimers()
	vi.useRealTimers()
})

describe('invalidateFromSSE', () => {
	it('always invalidates events history and byEntity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'task',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.events.history(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.events.byEntity(entityId),
		})
	})

	it('invalidates objects for task entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'task',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
	})

	it('invalidates objects and bets for bet entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'bet',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.bets.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
	})

	it('invalidates objects for insight entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'insight',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
	})

	it('invalidates objects for loop entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'loop',
			entity_id: entityId,
			action: 'status_changed',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.graph(entityId),
		})
		expect(qc.invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: queryKeys.bets.all(workspaceId),
		})
	})

	it('invalidates objects for knowledge entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'knowledge',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
	})

	it('invalidates relationships for relationship entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'relationship',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.relationships.all(workspaceId),
		})
	})

	it('invalidates triggers for trigger entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.triggers.all(workspaceId),
		})
	})

	it('invalidates session queries (prefix) immediately for session entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: ['sessions'] }),
		)
	})

	it('invalidates notifications for notification entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'notification',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.notifications.all(workspaceId),
		})
	})

	it('invalidates actors for actor entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'actor',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.actors.all(workspaceId),
		})
	})

	it('invalidates workspaces for workspace entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'workspace',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaces.all(),
		})
	})

	it('invalidates workspace skills for workspace_skill entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'workspace_skill',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
	})

	it('invalidates all agent skill attachments for agent_skill entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'agent_skill',
			entity_id: entityId,
			action: 'attached',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ['agent-skill-attachments'],
		})
	})

	it('emits trigger_fired analytics when a trigger entity carries the fire action', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: 'trg-1',
			action: 'trigger_fired',
			event_id: 'evt-1',
		} as never)
		expect(trackTriggerFired).toHaveBeenCalledWith({
			entity_id: 'trg-1',
			entity_type: 'trigger',
			flow_id: 'evt-1',
		})
	})

	it('does not emit trigger_fired for other trigger actions', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: 'trg-1',
			action: 'updated',
		} as never)
		expect(trackTriggerFired).not.toHaveBeenCalled()
	})

	it('emits agent_session_completed on completed/failed/timeout actions with outcome', async () => {
		const session = { triggerId: null, config: {} }
		vi.mocked(api.sessions.get).mockResolvedValue(session as never)

		const qc = createMockQueryClient()
		for (const [action, outcome] of [
			['session_completed', 'completed'],
			['session_failed', 'failed'],
			['session_timeout', 'timeout'],
		] as const) {
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'session',
				entity_id: 'sess-1',
				action,
				event_id: 'evt-2',
			} as never)
		}
		await vi.waitFor(() => expect(trackAgentSessionCompleted).toHaveBeenCalledTimes(3))
		expect(trackAgentSessionCompleted).toHaveBeenNthCalledWith(1, {
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'completed',
			flow_id: 'evt-2',
			trigger_id: null,
			trigger_type: null,
		})
		expect(trackAgentSessionCompleted).toHaveBeenNthCalledWith(2, {
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'failed',
			flow_id: 'evt-2',
			trigger_id: null,
			trigger_type: null,
		})
		expect(trackAgentSessionCompleted).toHaveBeenNthCalledWith(3, {
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'timeout',
			flow_id: 'evt-2',
			trigger_id: null,
			trigger_type: null,
		})
	})

	it('forwards the session row trigger_id and config.trigger_type as G2 provenance', async () => {
		vi.mocked(api.sessions.get).mockResolvedValue({
			triggerId: 'trig-1',
			config: { trigger_type: 'cron' },
		} as never)

		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: 'sess-9',
			action: 'session_completed',
			event_id: 'evt-9',
		} as never)

		await vi.waitFor(() => expect(trackAgentSessionCompleted).toHaveBeenCalledOnce())
		expect(trackAgentSessionCompleted).toHaveBeenCalledWith({
			entity_id: 'sess-9',
			entity_type: 'session',
			outcome: 'completed',
			flow_id: 'evt-9',
			trigger_id: 'trig-1',
			trigger_type: 'cron',
		})
	})

	it('still emits the completion without provenance when the session row cannot be read', async () => {
		vi.mocked(api.sessions.get).mockRejectedValueOnce(new Error('404 not found'))

		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: 'sess-gone',
			action: 'session_completed',
			event_id: 'evt-10',
		} as never)

		await vi.waitFor(() => expect(trackAgentSessionCompleted).toHaveBeenCalledOnce())
		expect(trackAgentSessionCompleted).toHaveBeenCalledWith({
			entity_id: 'sess-gone',
			entity_type: 'session',
			outcome: 'completed',
			flow_id: 'evt-10',
			trigger_id: null,
			trigger_type: null,
		})
	})

	it('does not emit agent_session_completed for routine session updates', async () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'session',
			entity_id: 'sess-1',
			action: 'updated',
		} as never)
		await Promise.resolve()
		expect(api.sessions.get).not.toHaveBeenCalled()
		expect(trackAgentSessionCompleted).not.toHaveBeenCalled()
	})
})

describe('invalidateFromSSE session batching', () => {
	const sessionEvent = (action: string, id = 'sess-1') =>
		({ entity_type: 'session', entity_id: id, action }) as never

	function seededClient() {
		const qc = new QueryClient()
		const keys = {
			list: queryKeys.sessions.all(workspaceId),
			paged: [...queryKeys.sessions.all(workspaceId), 'paged'],
			detail: queryKeys.sessions.detail('sess-1'),
			logs: queryKeys.sessions.logs('sess-1'),
			byActor: queryKeys.sessions.byActor(workspaceId, 'actor-1'),
			byConversation: queryKeys.sessions.byConversation(workspaceId, 'conv-1'),
			billing: queryKeys.billing.usage(workspaceId),
		}
		for (const key of Object.values(keys)) qc.setQueryData(key, [])
		const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated
		return { qc, keys, invalidated }
	}

	it('a burst of session_updated events gives one sessions list refetch and no billing refetch', () => {
		const qc = createMockQueryClient()
		const burst = 25
		for (let i = 0; i < burst; i++) {
			invalidateFromSSE(qc as never, workspaceId, sessionEvent('session_updated'))
		}
		const listCalls = () =>
			qc.invalidateQueries.mock.calls.filter(
				([arg]) =>
					arg.exact === true &&
					JSON.stringify(arg.queryKey) === JSON.stringify(queryKeys.sessions.all(workspaceId)),
			)
		expect(listCalls()).toHaveLength(0)
		vi.advanceTimersByTime(5_000)
		expect(listCalls()).toHaveLength(1)
		vi.advanceTimersByTime(60_000)
		expect(listCalls()).toHaveLength(1)
		expect(qc.invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: queryKeys.billing.usage(workspaceId),
		})
	})

	it('opens a new window for events that arrive after the previous one fired', () => {
		const { qc, keys, invalidated } = seededClient()
		invalidateFromSSE(qc, workspaceId, sessionEvent('session_updated'))
		vi.advanceTimersByTime(5_000)
		expect(invalidated(keys.list)).toBe(true)
		qc.setQueryData(keys.list, [])
		expect(invalidated(keys.list)).toBe(false)
		invalidateFromSSE(qc, workspaceId, sessionEvent('session_updated'))
		expect(invalidated(keys.list)).toBe(false)
		vi.advanceTimersByTime(5_000)
		expect(invalidated(keys.list)).toBe(true)
	})

	it('still invalidates session detail, logs and other session queries immediately', () => {
		const { qc, keys, invalidated } = seededClient()
		invalidateFromSSE(qc, workspaceId, sessionEvent('session_updated'))
		expect(invalidated(keys.detail)).toBe(true)
		expect(invalidated(keys.logs)).toBe(true)
		expect(invalidated(keys.byActor)).toBe(true)
		expect(invalidated(keys.byConversation)).toBe(true)
		expect(invalidated(keys.paged)).toBe(true)
		// The coalesced list and billing wait / are skipped.
		expect(invalidated(keys.list)).toBe(false)
		expect(invalidated(keys.billing)).toBe(false)
	})

	it.each(['session_credit_debited', 'session_budget_stopped'])(
		'%s still refetches billing usage',
		(action) => {
			const { qc, keys, invalidated } = seededClient()
			invalidateFromSSE(qc, workspaceId, sessionEvent(action))
			expect(invalidated(keys.billing)).toBe(false)
			vi.advanceTimersByTime(5_000)
			expect(invalidated(keys.billing)).toBe(true)
		},
	)

	it.each(['session_completed', 'session_failed', 'session_timeout'])(
		'terminal %s refetches billing usage',
		(action) => {
			vi.mocked(api.sessions.get).mockResolvedValue({ triggerId: null, config: {} } as never)
			const { qc, keys, invalidated } = seededClient()
			invalidateFromSSE(qc, workspaceId, sessionEvent(action))
			expect(invalidated(keys.billing)).toBe(false)
			vi.advanceTimersByTime(5_000)
			expect(invalidated(keys.billing)).toBe(true)
		},
	)

	it.each(['session_updated', 'session_created', 'session_started', 'session_resumed'])(
		'%s does not refetch billing usage',
		(action) => {
			const { qc, keys, invalidated } = seededClient()
			invalidateFromSSE(qc, workspaceId, sessionEvent(action))
			expect(invalidated(keys.billing)).toBe(false)
		},
	)

	it('a burst of billing events gives one billing refetch per window', () => {
		vi.mocked(api.sessions.get).mockResolvedValue({ triggerId: null, config: {} } as never)
		const qc = createMockQueryClient()
		const billingCalls = () =>
			qc.invalidateQueries.mock.calls.filter(
				([arg]) =>
					JSON.stringify(arg.queryKey) === JSON.stringify(queryKeys.billing.usage(workspaceId)),
			)
		for (let i = 0; i < 25; i++) {
			invalidateFromSSE(qc as never, workspaceId, sessionEvent('session_completed', `s-${i}`))
			invalidateFromSSE(qc as never, workspaceId, sessionEvent('session_credit_debited', `s-${i}`))
		}
		expect(billingCalls()).toHaveLength(0)
		vi.advanceTimersByTime(5_000)
		expect(billingCalls()).toHaveLength(1)
		// Joins a fetch already in flight rather than cancelling it.
		expect(billingCalls()[0][1]).toEqual({ cancelRefetch: false })
		vi.advanceTimersByTime(60_000)
		expect(billingCalls()).toHaveLength(1)
	})

	describe('against a real query client with a slow endpoint', () => {
		// Counts requests that would reach the server. A cancelled fetch still
		// counts: the request has already left the browser.
		function mountSlow(qc: QueryClient, queryKey: readonly unknown[], durationMs: number) {
			const requests = { n: 0 }
			new QueryObserver(qc, {
				queryKey,
				queryFn: async () => {
					requests.n++
					await new Promise((r) => setTimeout(r, durationMs))
					return 'ok'
				},
			}).subscribe(() => {})
			return requests
		}

		it('does not restart a billing fetch that is already in flight', async () => {
			vi.mocked(api.sessions.get).mockResolvedValue({ triggerId: null, config: {} } as never)
			const qc = new QueryClient()
			const requests = mountSlow(qc, queryKeys.billing.usage(workspaceId), 10_000)
			// Let the first load finish: only a query that already has data is
			// cancelled and restarted by an invalidation.
			await vi.advanceTimersByTimeAsync(10_000)

			invalidateFromSSE(qc, workspaceId, sessionEvent('session_completed'))
			await vi.advanceTimersByTimeAsync(5_000)
			expect(requests.n).toBe(2) // the window's refetch, now in flight for 10s

			// A second event whose window fires mid-fetch.
			invalidateFromSSE(qc, workspaceId, sessionEvent('session_completed', 'sess-2'))
			await vi.advanceTimersByTimeAsync(5_000)

			expect(requests.n).toBe(2)
		})

		it('turns 100 replayed session events into one billing refetch', async () => {
			vi.mocked(api.sessions.get).mockResolvedValue({ triggerId: null, config: {} } as never)
			const qc = new QueryClient()
			const billing = mountSlow(qc, queryKeys.billing.usage(workspaceId), 300)
			const list = mountSlow(qc, queryKeys.sessions.all(workspaceId), 300)
			await vi.advanceTimersByTimeAsync(1_000)
			billing.n = 0
			list.n = 0

			// What reconnect replay delivers after a deploy: up to 100 events at once.
			for (let i = 0; i < 100; i++) {
				const action = i % 2 ? 'session_credit_debited' : 'session_completed'
				invalidateFromSSE(qc, workspaceId, sessionEvent(action, `s-${i}`))
			}
			await vi.advanceTimersByTimeAsync(20_000)

			expect(billing.n).toBe(1)
			expect(list.n).toBe(1)
		})
	})
})
