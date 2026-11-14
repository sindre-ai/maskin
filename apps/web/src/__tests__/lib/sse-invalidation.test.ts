import { queryKeys } from '@/lib/query-keys'
import { invalidateFromSSE } from '@/lib/sse-invalidation'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
	api: {
		sessions: { get: vi.fn() },
	},
}))

import { trackEvent } from '@/lib/analytics'
import { api } from '@/lib/api'

function createMockQueryClient() {
	return {
		invalidateQueries: vi.fn(),
		getQueryCache: () => ({ findAll: () => [] }),
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
	it('invalidates the entity’s own history at once and the history views once per window', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'task',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.events.byEntity(entityId),
		})
		expect(qc.invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: queryKeys.events.history(workspaceId),
		})
		vi.advanceTimersByTime(5_000)
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			{ queryKey: queryKeys.events.history(workspaceId) },
			{ cancelRefetch: false },
		)
	})

	it('invalidates objects for task entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'task',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.objects.all(workspaceId) }),
		)
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
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.objects.all(workspaceId) }),
		)
	})

	it('invalidates objects for insight entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'insight',
			entity_id: entityId,
			action: 'created',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.objects.all(workspaceId) }),
		)
	})

	it('invalidates objects for loop entity', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'loop',
			entity_id: entityId,
			action: 'status_changed',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.objects.all(workspaceId) }),
		)
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
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.objects.all(workspaceId) }),
		)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.detail(entityId),
		})
	})

	it('refreshes a draft card when it is approved or sent, whatever its object type', () => {
		for (const action of ['approved', 'delivered']) {
			const qc = createMockQueryClient()
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'content',
				entity_id: entityId,
				action,
			} as never)
			expect(qc.invalidateQueries).toHaveBeenCalledWith({
				queryKey: queryKeys.objects.detail(entityId),
			})
		}
	})

	it('refreshes an object of a workspace-defined type when it is updated', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'linkedin_post',
			entity_id: entityId,
			action: 'updated',
		} as never)
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

	it('refetches the object graphs once for a burst of relationship events', () => {
		const qc = createMockQueryClient()
		const graphCalls = () =>
			qc.invalidateQueries.mock.calls.filter(
				([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(['objects', 'graph']),
			)
		for (let i = 0; i < 5; i++) {
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'relationship',
				entity_id: `rel-${i}`,
				action: 'created',
			} as never)
		}
		expect(graphCalls()).toHaveLength(0)
		vi.advanceTimersByTime(5_000)
		expect(graphCalls()).toHaveLength(1)
	})

	it('refetches the unread and For You lists once for a burst of comments', () => {
		const qc = createMockQueryClient()
		const calls = (key: readonly unknown[]) =>
			qc.invalidateQueries.mock.calls.filter(
				([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(key),
			)
		for (let i = 0; i < 5; i++) {
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'task',
				entity_id: `task-${i}`,
				action: 'commented',
			} as never)
		}
		expect(calls(['subscriptions', 'unread', workspaceId])).toHaveLength(0)
		expect(calls(queryKeys.forYou.list(workspaceId))).toHaveLength(0)
		vi.advanceTimersByTime(5_000)
		expect(calls(['subscriptions', 'unread', workspaceId])).toHaveLength(1)
		expect(calls(queryKeys.forYou.list(workspaceId))).toHaveLength(1)
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

	it('refetches actors once per window for actor entity', () => {
		const qc = createMockQueryClient()
		for (let i = 0; i < 10; i++) {
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'actor',
				entity_id: entityId,
				action: 'updated',
			} as never)
		}
		expect(qc.invalidateQueries).not.toHaveBeenCalledWith(
			{ queryKey: queryKeys.actors.all(workspaceId) },
			expect.anything(),
		)
		vi.advanceTimersByTime(5_000)
		const actorCalls = qc.invalidateQueries.mock.calls.filter(
			([arg]) => JSON.stringify(arg.queryKey) === JSON.stringify(queryKeys.actors.all(workspaceId)),
		)
		expect(actorCalls).toHaveLength(1)
	})

	it('refetches actors for an installed_loop event, since a version update renames its agents', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'installed_loop',
			entity_id: entityId,
			action: 'updated',
		} as never)
		vi.advanceTimersByTime(5_000)
		expect(qc.invalidateQueries).toHaveBeenCalledWith(
			{ queryKey: queryKeys.actors.all(workspaceId) },
			{ cancelRefetch: false },
		)
	})

	it('refreshes the integration list, and with it every agent access view, for an integration event', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'integration',
			entity_id: entityId,
			action: 'updated',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
		// The per-agent access query lives under that same key, so one invalidation covers it.
		expect(queryKeys.integrations.agentAccess(workspaceId, 'agent-1').slice(0, 2)).toEqual(
			queryKeys.integrations.all(workspaceId),
		)
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

	it('sends nothing to PostHog for trigger_fired (the browser copy was half of all events)', () => {
		const qc = createMockQueryClient()
		invalidateFromSSE(qc as never, workspaceId, {
			entity_type: 'trigger',
			entity_id: 'trg-1',
			action: 'trigger_fired',
			event_id: 'evt-1',
		} as never)
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ['loops', workspaceId, 'activity'],
		})
		expect(trackEvent).not.toHaveBeenCalled()
	})

	it('sends nothing to PostHog and reads no session row on completed/failed/timeout', async () => {
		const qc = createMockQueryClient()
		for (const action of ['session_completed', 'session_failed', 'session_timeout']) {
			invalidateFromSSE(qc as never, workspaceId, {
				entity_type: 'session',
				entity_id: 'sess-1',
				action,
				event_id: 'evt-2',
			} as never)
		}
		await Promise.resolve()
		expect(api.sessions.get).not.toHaveBeenCalled()
		expect(trackEvent).not.toHaveBeenCalled()
	})
})

describe('invalidateFromSSE session batching', () => {
	const sessionEvent = (action: string, id = 'sess-1') =>
		({ entity_type: 'session', entity_id: id, action }) as never

	function seededClient() {
		const qc = new QueryClient()
		const keys = {
			list: queryKeys.sessions.all(workspaceId),
			stats: queryKeys.sessions.stats(workspaceId),
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
		// The coalesced lists and billing wait / are skipped.
		expect(invalidated(keys.list)).toBe(false)
		expect(invalidated(keys.stats)).toBe(false)
		expect(invalidated(keys.billing)).toBe(false)
	})

	it('leaves another session’s detail and logs alone', () => {
		const { qc, keys, invalidated } = seededClient()
		const other = queryKeys.sessions.detail('sess-2')
		const otherLogs = queryKeys.sessions.logs('sess-2')
		qc.setQueryData(other, {})
		qc.setQueryData(otherLogs, [])
		invalidateFromSSE(qc, workspaceId, sessionEvent('session_updated'))
		expect(invalidated(keys.detail)).toBe(true)
		expect(invalidated(other)).toBe(false)
		expect(invalidated(otherLogs)).toBe(false)
	})

	it('coalesces the per-agent stats on a longer window so a burst cannot refetch them per event', () => {
		const { qc, keys, invalidated } = seededClient()
		for (let i = 0; i < 25; i++) {
			invalidateFromSSE(qc, workspaceId, sessionEvent('session_updated'))
		}
		vi.advanceTimersByTime(5_000)
		expect(invalidated(keys.stats)).toBe(false)
		vi.advanceTimersByTime(25_000)
		expect(invalidated(keys.stats)).toBe(true)
	})

	it.each(['session_credit_debited', 'session_budget_stopped', 'session_stopped'])(
		'%s still refetches billing usage',
		(action) => {
			const { qc, keys, invalidated } = seededClient()
			invalidateFromSSE(qc, workspaceId, sessionEvent(action))
			expect(invalidated(keys.billing)).toBe(false)
			vi.advanceTimersByTime(15_000)
			expect(invalidated(keys.billing)).toBe(true)
		},
	)

	it.each(['session_completed', 'session_failed', 'session_timeout'])(
		'terminal %s refetches billing usage',
		(action) => {
			const { qc, keys, invalidated } = seededClient()
			invalidateFromSSE(qc, workspaceId, sessionEvent(action))
			expect(invalidated(keys.billing)).toBe(false)
			vi.advanceTimersByTime(15_000)
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
		// Billing has its own, longer window than the sessions list.
		expect(billingCalls()).toHaveLength(0)
		vi.advanceTimersByTime(10_000)
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
			const qc = new QueryClient()
			const requests = mountSlow(qc, queryKeys.billing.usage(workspaceId), 20_000)
			// Let the first load finish: only a query that already has data is
			// cancelled and restarted by an invalidation.
			await vi.advanceTimersByTimeAsync(20_000)

			invalidateFromSSE(qc, workspaceId, sessionEvent('session_completed'))
			await vi.advanceTimersByTimeAsync(15_000)
			expect(requests.n).toBe(2) // the window's refetch, now in flight for 20s

			// A second event whose window fires mid-fetch.
			invalidateFromSSE(qc, workspaceId, sessionEvent('session_completed', 'sess-2'))
			await vi.advanceTimersByTimeAsync(15_000)

			expect(requests.n).toBe(2)
		})

		it('turns 100 replayed session events into one billing refetch', async () => {
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

describe('invalidateFromSSE in a background tab', () => {
	const sessionEvent = (action: string, id = 'sess-1') =>
		({ entity_type: 'session', entity_id: id, action }) as never

	function setVisibility(state: 'visible' | 'hidden') {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
		document.dispatchEvent(new Event('visibilitychange'))
	}

	afterEach(() => {
		Reflect.deleteProperty(document, 'visibilityState')
	})

	function mountSlow(qc: QueryClient, queryKey: readonly unknown[]) {
		const requests = { n: 0 }
		new QueryObserver(qc, {
			queryKey,
			queryFn: async () => {
				requests.n++
				await new Promise((r) => setTimeout(r, 300))
				return 'ok'
			},
		}).subscribe(() => {})
		return requests
	}

	it('marks queries stale without refetching while hidden, then catches up once on return', async () => {
		const qc = new QueryClient()
		const list = mountSlow(qc, queryKeys.sessions.all(workspaceId))
		const history = mountSlow(qc, queryKeys.events.history(workspaceId))
		await vi.advanceTimersByTimeAsync(1_000)
		list.n = 0
		history.n = 0

		setVisibility('hidden')
		for (let i = 0; i < 20; i++) {
			invalidateFromSSE(qc, workspaceId, sessionEvent('session_updated', `s-${i}`))
		}
		await vi.advanceTimersByTimeAsync(30_000)
		expect(list.n).toBe(0)
		expect(history.n).toBe(0)

		setVisibility('visible')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(list.n).toBe(1)
		expect(history.n).toBe(1)
	})

	it('does not refetch on return when nothing was invalidated while hidden', async () => {
		const qc = new QueryClient()
		const list = mountSlow(qc, queryKeys.sessions.all(workspaceId))
		await vi.advanceTimersByTimeAsync(1_000)
		list.n = 0

		setVisibility('hidden')
		setVisibility('visible')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(list.n).toBe(0)
	})
})

describe('invalidateFromSSE request counts for a burst of events', () => {
	const WINDOW_MS = 5_000

	// Counts requests that would reach the server for each mounted query.
	function mountCounting(qc: QueryClient, queryKey: readonly unknown[], data: unknown = 'ok') {
		const requests = { n: 0 }
		new QueryObserver(qc, {
			queryKey,
			queryFn: async () => {
				requests.n++
				return data
			},
		}).subscribe(() => {})
		return requests
	}

	const strip = (id: string) => ({ id, status: 'running' })
	const messagesPage = (sessionIds: string[]) => ({
		pages: [
			{
				messages: [{ id: 1, spawned_sessions: sessionIds.map(strip) }],
				has_more: false,
			},
		],
		pageParams: [undefined],
	})

	async function mountAll(qc: QueryClient) {
		const lists = {
			chatList: mountCounting(qc, queryKeys.conversations.listInfinite(workspaceId, {})),
			unreadChats: mountCounting(qc, queryKeys.conversations.unreadCount(workspaceId)),
			actors: mountCounting(qc, queryKeys.actors.all(workspaceId)),
			history: mountCounting(qc, queryKeys.events.history(workspaceId)),
			forYou: mountCounting(qc, queryKeys.forYou.list(workspaceId)),
			unread: mountCounting(qc, queryKeys.subscriptions.unread(workspaceId)),
			openChat: mountCounting(
				qc,
				queryKeys.conversations.messages('chat-open', { limit: 50 }),
				messagesPage(['sess-open']),
			),
			otherChat: mountCounting(
				qc,
				queryKeys.conversations.messages('chat-other', { limit: 50 }),
				messagesPage(['sess-other']),
			),
		}
		await vi.advanceTimersByTimeAsync(1_000)
		for (const r of Object.values(lists)) r.n = 0
		return lists
	}

	it('30 events in 10 seconds give at most 2 refetches per list', async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } })
		const lists = await mountAll(qc)

		for (let i = 0; i < 30; i++) {
			const at = (n: number) => `e-${i}-${n}`
			invalidateFromSSE(qc, workspaceId, {
				id: at(0),
				entity_type: 'conversation',
				entity_id: 'chat-open',
				action: 'created',
			} as never)
			invalidateFromSSE(qc, workspaceId, {
				id: at(1),
				entity_type: 'actor',
				entity_id: `actor-${i}`,
				action: 'updated',
			} as never)
			invalidateFromSSE(qc, workspaceId, {
				id: at(2),
				entity_type: 'task',
				entity_id: 'task-1',
				action: 'commented',
			} as never)
			invalidateFromSSE(qc, workspaceId, {
				id: at(3),
				entity_type: 'notification',
				entity_id: `n-${i}`,
				action: 'created',
			} as never)
			// A session in a chat nobody has open here: the open chat must not refetch for it.
			invalidateFromSSE(qc, workspaceId, {
				id: at(4),
				entity_type: 'session',
				entity_id: 'sess-other',
				action: 'session_updated',
			} as never)
			await vi.advanceTimersByTimeAsync(10_000 / 30)
		}
		await vi.advanceTimersByTimeAsync(2 * WINDOW_MS)

		for (const [name, requests] of Object.entries(lists)) {
			if (name === 'openChat' || name === 'otherChat') continue
			expect(requests.n, name).toBeLessThanOrEqual(2)
		}
	})

	it('a chat message refetches only that conversation’s messages, at once', async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } })
		const lists = await mountAll(qc)

		invalidateFromSSE(qc, workspaceId, {
			id: 'e-1',
			entity_type: 'conversation',
			entity_id: 'chat-open',
			action: 'created',
		} as never)
		await vi.advanceTimersByTimeAsync(0)

		expect(lists.openChat.n).toBe(1)
		expect(lists.otherChat.n).toBe(0)
		// The list family waits for its window.
		expect(lists.chatList.n).toBe(0)
		await vi.advanceTimersByTimeAsync(WINDOW_MS)
		expect(lists.chatList.n).toBe(1)
		expect(lists.unreadChats.n).toBe(1)
	})

	it('a session event refetches only the chat whose strip carries it, at once', async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } })
		const lists = await mountAll(qc)

		invalidateFromSSE(qc, workspaceId, {
			id: 'e-1',
			entity_type: 'session',
			entity_id: 'sess-open',
			action: 'session_updated',
		} as never)
		// The paired delegation-strip frame has the same event id and must not fetch again.
		invalidateFromSSE(qc, workspaceId, {
			id: 'e-1',
			action: 'session.state_changed',
			session_id: 'sess-open',
		} as never)
		await vi.advanceTimersByTimeAsync(0)

		expect(lists.openChat.n).toBe(1)
		expect(lists.otherChat.n).toBe(0)
	})

	it('a session no cached strip carries is ignored unless it is new', async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } })
		const lists = await mountAll(qc)

		invalidateFromSSE(qc, workspaceId, {
			id: 'e-1',
			entity_type: 'session',
			entity_id: 'sess-unknown',
			action: 'session_updated',
		} as never)
		await vi.advanceTimersByTimeAsync(0)
		expect(lists.openChat.n).toBe(0)
		expect(lists.otherChat.n).toBe(0)

		// A new handoff can land in any open chat before a message carries it.
		invalidateFromSSE(qc, workspaceId, {
			id: 'e-2',
			entity_type: 'session',
			entity_id: 'sess-unknown',
			action: 'session_created',
		} as never)
		await vi.advanceTimersByTimeAsync(0)
		expect(lists.openChat.n).toBe(1)
		expect(lists.otherChat.n).toBe(1)
	})
})

describe('invalidateFromSSE throttled refetches', () => {
	const keyCalls = (qc: ReturnType<typeof createMockQueryClient>, key: readonly unknown[]) =>
		qc.invalidateQueries.mock.calls.filter(
			([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(key),
		)
	const facetsKey = ['objects', workspaceId, 'facets']
	const burst = (
		qc: ReturnType<typeof createMockQueryClient>,
		event: (i: number) => Record<string, unknown>,
		n = 6,
	) => {
		for (let i = 0; i < n; i++) invalidateFromSSE(qc as never, workspaceId, event(i) as never)
	}

	it('keeps the objects facets out of the immediate objects invalidation', () => {
		const qc = createMockQueryClient()
		burst(qc, (i) => ({ entity_type: 'task', entity_id: `t-${i}`, action: 'updated' }), 1)
		const call = keyCalls(qc, queryKeys.objects.all(workspaceId))[0]?.[0]
		expect(call.predicate({ queryKey: ['objects', workspaceId, 'facets', {}] })).toBe(false)
		expect(call.predicate({ queryKey: ['objects', workspaceId, 'listInfinite', {}] })).toBe(true)
		expect(call.predicate({ queryKey: ['objects', workspaceId, 'board', {}] })).toBe(true)
	})

	it('refetches facets once, on the trailing edge, for a burst of object events', () => {
		const qc = createMockQueryClient()
		burst(qc, (i) => ({ entity_type: 'bet', entity_id: `b-${i}`, action: 'updated' }))
		expect(keyCalls(qc, facetsKey)).toHaveLength(0)
		vi.advanceTimersByTime(4_999)
		expect(keyCalls(qc, facetsKey)).toHaveLength(0)
		vi.advanceTimersByTime(1)
		expect(keyCalls(qc, facetsKey)).toHaveLength(1)
		// A later event opens a new window.
		burst(qc, (i) => ({ entity_type: 'bet', entity_id: `c-${i}`, action: 'updated' }), 2)
		vi.advanceTimersByTime(5_000)
		expect(keyCalls(qc, facetsKey)).toHaveLength(2)
	})
})
