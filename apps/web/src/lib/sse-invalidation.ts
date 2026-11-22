import type { InfiniteData, InvalidateQueryFilters, QueryClient } from '@tanstack/react-query'
import type { MessagesListResponse } from './api'
import { queryKeys } from './query-keys'
import type { SSEEvent } from './sse'

const SESSION_COMPLETION_ACTIONS = new Map<string, 'completed' | 'failed' | 'timeout'>([
	['session_completed', 'completed'],
	['session_failed', 'failed'],
	['session_timeout', 'timeout'],
])

// Session events that can move the credit balance or end a run. Billing usage
// only needs a refetch on these; routine session_updated / session_started
// traffic does not change it.
const BILLING_INVALIDATING_ACTIONS = new Set([
	'session_credit_debited',
	'session_budget_stopped',
	'session_stopped',
])

// Trailing windows for the refetches a burst of session events would otherwise
// multiply. Agents PATCH current_activity on every step and a scheduled trigger
// can finish dozens of runs at once, so one busy minute emits a burst of
// session events; each target refetches once per window instead of per event.
//
// The workspace sessions list (?limit=100) drives the sidebar's live activity
// text, so it keeps a short window. Billing usage only moves on terminal and
// credit events and is the most expensive read in the app, so it gets a longer
// one. The server evicts its usage cache when it records those events
// (lib/events/record-event.ts), so a refetch is never answered from a snapshot
// older than the event no matter how long the window is.
const SESSIONS_REFETCH_MS = 5_000
// The per-agent stats group the whole session history server-side, so they get a longer
// window. They only feed counts and cost; live status comes from the 100-row list.
const SESSIONS_STATS_REFETCH_MS = 30_000
const BILLING_REFETCH_MS = 15_000
// Lists that follow the open item, not the event: the chat list family (list, reply threads,
// unread count), the actors list, the events history views, For you and the unread feed. Each
// is one refetch per window however many events land in it. The open chat, the open session
// and the open object's own history are not here: they are invalidated per event, immediately.
const LIST_REFETCH_MS = 5_000
// A relationship event marks every open object graph stale, and each graph is a dozen database
// queries on the server. A burst of relationship events (an agent wiring up a loop) used to
// refetch every open graph once per event, so one trailing refetch per window is enough.
const GRAPH_REFETCH_MS = 5_000
// The Objects page facets are ~10 count queries on the server, and any object event used to
// refetch them. Our own edits still refresh them at once (mutation onSuccess hooks invalidate
// the whole objects prefix); only the SSE-driven path waits for the window to end.
const FACETS_REFETCH_MS = 5_000
const trailingRefetchTimers = new Map<string, ReturnType<typeof setTimeout>>()

const isTabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

// Query clients that have deferred invalidations waiting for their tab to
// come back, and the ones we have already attached a visibility listener to.
const dirtyWhileHidden = new WeakSet<QueryClient>()
const listening = new WeakSet<QueryClient>()

// A background tab has nobody looking at it, but invalidating an active query
// refetches it right away — with several tabs open that multiplies every SSE
// event by the tab count. While hidden, only mark queries stale (no refetch)
// and catch up once, on the invalidated ones that are still on screen, when
// the tab becomes visible again.
function invalidate(
	queryClient: QueryClient,
	filters: InvalidateQueryFilters,
	options?: { cancelRefetch?: boolean },
) {
	if (!isTabHidden()) {
		return options
			? queryClient.invalidateQueries(filters, options)
			: queryClient.invalidateQueries(filters)
	}
	dirtyWhileHidden.add(queryClient)
	if (!listening.has(queryClient)) {
		listening.add(queryClient)
		document.addEventListener('visibilitychange', () => {
			if (isTabHidden() || !dirtyWhileHidden.has(queryClient)) return
			dirtyWhileHidden.delete(queryClient)
			void queryClient.refetchQueries({
				type: 'active',
				predicate: (query) => query.state.isInvalidated,
			})
		})
	}
	return queryClient.invalidateQueries({ ...filters, refetchType: 'none' }, options)
}

function scheduleTrailingRefetch(
	queryClient: QueryClient,
	timerKey: string,
	filters: InvalidateQueryFilters,
	delayMs: number,
) {
	if (trailingRefetchTimers.has(timerKey)) return
	trailingRefetchTimers.set(
		timerKey,
		setTimeout(() => {
			trailingRefetchTimers.delete(timerKey)
			// cancelRefetch: false joins a fetch that is already in flight instead
			// of cancelling it and starting another (the cancelled request still
			// reaches the server). An event that lands mid-fetch re-arms the timer,
			// so it is never lost.
			invalidate(queryClient, filters, { cancelRefetch: false })
		}, delayMs),
	)
}

// Actions that can add a session to a chat's delegation strip. A session no cached strip
// carries yet is only worth a chat refetch when it is new.
const NEW_SESSION_ACTIONS = new Set(['created', 'session_created', 'session_started'])

// A session event comes as a generic frame, then (for a handed-off sub-session) a
// `session.state_changed` frame with the same event id. The first one refreshes the chat; the
// second must not start a second fetch of the same page.
let lastSessionChatSyncId: string | null = null

// The conversations whose cached messages carry this session in their delegation strip. The
// events name the session, not the chat, so the owner is read off the cached pages.
function conversationsCarryingSession(queryClient: QueryClient, sessionId: string): Set<string> {
	const owners = new Set<string>()
	const queries = queryClient.getQueryCache().findAll({
		queryKey: ['conversations', 'detail'],
		predicate: (query) => query.queryKey[3] === 'messages',
	})
	for (const query of queries) {
		const data = query.state.data as InfiniteData<MessagesListResponse> | undefined
		const carries = data?.pages?.some(
			(page) =>
				page.messages.some((m) => m.spawned_sessions?.some((s) => s.id === sessionId)) ||
				page.pending_handoffs?.some((s) => s.id === sessionId),
		)
		if (carries) owners.add(String(query.queryKey[2]))
	}
	return owners
}

// Refreshes only the chat(s) whose strip shows this session, immediately. Before this every
// session event in the workspace refetched every open chat's messages.
function syncChatsForSession(queryClient: QueryClient, event: SSEEvent, sessionId: string) {
	if (event.id !== undefined && event.id === lastSessionChatSyncId) return
	lastSessionChatSyncId = event.id ?? null
	const owners = conversationsCarryingSession(queryClient, sessionId)
	if (owners.size > 0) {
		for (const conversationId of owners) {
			invalidate(queryClient, { queryKey: queryKeys.conversations.messagesPrefix(conversationId) })
		}
		return
	}
	// Nothing cached carries it. A brand-new handoff can still land in an open chat, so a
	// new session refreshes the open chats; any other event for an unknown session shows nowhere.
	if (!NEW_SESSION_ACTIONS.has(event.action)) return
	invalidate(queryClient, {
		queryKey: ['conversations', 'detail'],
		predicate: (query) => query.queryKey[3] === 'messages',
	})
}

// Things that live outside the query cache (a custom loop view's frame) listen for the same
// stream here instead of opening a second one. `null` means events may have been missed
// (a reconnect), so a listener should treat everything it shows as possibly stale.
export type SSEListener = (event: SSEEvent | null) => void
const sseListeners = new Set<SSEListener>()

export function subscribeToSSE(listener: SSEListener): () => void {
	sseListeners.add(listener)
	return () => {
		sseListeners.delete(listener)
	}
}

export function notifySSEGap() {
	for (const listener of sseListeners) listener(null)
}

function scheduleForYouRefetch(queryClient: QueryClient, workspaceId: string) {
	scheduleTrailingRefetch(
		queryClient,
		`for-you:${workspaceId}`,
		{ queryKey: queryKeys.forYou.list(workspaceId) },
		LIST_REFETCH_MS,
	)
}

export function invalidateFromSSE(queryClient: QueryClient, workspaceId: string, event: SSEEvent) {
	for (const listener of sseListeners) {
		try {
			listener(event)
		} catch (err) {
			// One broken listener must not stop the cache invalidation below.
			console.error('[sse] listener failed', err)
		}
	}

	// `session.state_changed` frames (bet/444b-handed-off-strip) carry a
	// `SessionStateChangedPayload` — not the generic `events` row shape — so
	// `entity_type`/`entity_id` are absent and the switch below never matches
	// them. They pair a sub-session's live status with the delegation strip
	// rendered on `spawned_sessions`, which is embedded in the messages list
	// response, so the chat that owns the strip is the only one to refetch.
	if (event.action === 'session.state_changed') {
		const sessionId = (event as unknown as { session_id?: string }).session_id
		if (sessionId) syncChatsForSession(queryClient, event, sessionId)
		return
	}

	// Events history views are lists of everything that happens: a mounted one refetches once
	// per window, an unmounted one is only marked stale for its next mount.
	scheduleTrailingRefetch(
		queryClient,
		`events-history:${workspaceId}`,
		{ queryKey: queryKeys.events.history(workspaceId) },
		LIST_REFETCH_MS,
	)
	invalidate(queryClient, { queryKey: queryKeys.events.byEntity(event.entity_id) })
	// Live-refresh the knowledge doc-header reference-count chip. The DoD
	// tolerates a 5-minute lag (matches the hook's staleTime), but when a
	// fresh cite lands over SSE we already know a downstream agent read this
	// object — invalidate the counter so the chip catches up in the same tick.
	if (event.action === 'workspace_knowledge_referenced') {
		invalidate(queryClient, { queryKey: queryKeys.objects.references(event.entity_id) })
	}

	// A draft approved or sent changes its card (Approved, sending, then Sent). The draft can
	// be any object type, including ones the entity-type switch below does not list.
	if (event.action === 'approved' || event.action === 'delivered') {
		invalidate(queryClient, { queryKey: queryKeys.objects.detail(event.entity_id) })
	}

	// New comments may change unread counts for any subscriber in this workspace
	// and the subscriber list for the entity that was commented on (the latter
	// because the commenter auto-subscribes server-side).
	if (event.action === 'commented') {
		scheduleTrailingRefetch(
			queryClient,
			`unread:${workspaceId}`,
			{ queryKey: ['subscriptions', 'unread', workspaceId] },
			LIST_REFETCH_MS,
		)
		// A reply on a thread can settle a curated For You item.
		scheduleForYouRefetch(queryClient, workspaceId)
		invalidate(queryClient, {
			queryKey: queryKeys.subscriptions.subscribers(event.entity_type, event.entity_id),
		})
		// Also refresh the detail/graph so unread_count + subscriber_count update.
		invalidate(queryClient, { queryKey: queryKeys.objects.detail(event.entity_id) })
		invalidate(queryClient, { queryKey: queryKeys.objects.graph(event.entity_id) })
	}

	// Invalidate based on entity type
	switch (event.entity_type) {
		case 'insight':
		case 'bet':
		case 'task':
		case 'loop':
		case 'knowledge':
			// Everything under the objects prefix except the facets, which trail below.
			invalidate(queryClient, {
				queryKey: queryKeys.objects.all(workspaceId),
				predicate: (query) => query.queryKey[2] !== 'facets',
			})
			scheduleTrailingRefetch(
				queryClient,
				`facets:${workspaceId}`,
				{ queryKey: [...queryKeys.objects.all(workspaceId), 'facets'] },
				FACETS_REFETCH_MS,
			)
			invalidate(queryClient, { queryKey: queryKeys.objects.detail(event.entity_id) })
			invalidate(queryClient, { queryKey: queryKeys.objects.graph(event.entity_id) })
			if (event.entity_type === 'bet') {
				invalidate(queryClient, { queryKey: queryKeys.bets.all(workspaceId) })
			}
			if (event.entity_type === 'loop') {
				invalidate(queryClient, { queryKey: queryKeys.loops.all(workspaceId) })
			}
			break
		case 'relationship':
			invalidate(queryClient, { queryKey: queryKeys.relationships.all(workspaceId) })
			scheduleTrailingRefetch(
				queryClient,
				`graphs:${workspaceId}`,
				{ queryKey: ['objects', 'graph'] },
				GRAPH_REFETCH_MS,
			)
			break
		case 'trigger':
			invalidate(queryClient, { queryKey: queryKeys.triggers.all(workspaceId) })
			if (event.action === 'trigger_fired') {
				// Loop-detail "Latest activity" is a join through metadata.trigger_ids
				// keyed to the trigger — we don't know which loop from the payload,
				// so invalidate every open loop-activity query in this workspace.
				invalidate(queryClient, { queryKey: ['loops', workspaceId, 'activity'] })
			}
			break
		case 'session': {
			// A handoff exists from the moment `create_sub_chat` runs, before any message
			// carries it; the messages list returns it as `pending_handoffs`.
			syncChatsForSession(queryClient, event, event.entity_id)
			// Broad prefix invalidation covers all session queries including byActor,
			// detail and logs — except the workspace list (exactly ['sessions', ws]),
			// which is coalesced below, and the per-agent stats
			// (['sessions', ws, 'stats']), which are coalesced on a longer window. The prefix
			// matches both, so exclude them here.
			// A per-session query (detail, logs) is only stale when the event is about that
			// session — otherwise every mounted `useSession` refetches on every event for
			// every other session in the workspace.
			invalidate(queryClient, {
				queryKey: ['sessions'],
				predicate: (query) => {
					const key = query.queryKey
					if (key[1] === 'detail') return key[2] === event.entity_id
					if (key[2] === 'logs') return key[1] === event.entity_id
					if (key[1] !== workspaceId) return true
					return !(key.length === 2 || (key.length === 3 && key[2] === 'stats'))
				},
			})
			scheduleTrailingRefetch(
				queryClient,
				`sessions:${workspaceId}`,
				{
					queryKey: queryKeys.sessions.all(workspaceId),
					exact: true,
				},
				SESSIONS_REFETCH_MS,
			)
			scheduleTrailingRefetch(
				queryClient,
				`sessions-stats:${workspaceId}`,
				{
					queryKey: queryKeys.sessions.stats(workspaceId),
					exact: true,
				},
				SESSIONS_STATS_REFETCH_MS,
			)
			// Same reasoning as trigger_fired above — session lifecycle events feed
			// into the loop activity view via the trigger id join.
			invalidate(queryClient, { queryKey: ['loops', workspaceId, 'activity'] })
			// Sessions burn credits and can flip the workspace into PAUSED · NO
			// CREDITS mid-flight. The D6 chip reads through `useUsageState` →
			// `useBillingUsage`; only credit debits, budget stops and terminal
			// events can change that, so routine session updates skip the refetch
			// and the rest coalesce into one refetch per window.
			const outcome = SESSION_COMPLETION_ACTIONS.get(event.action)
			if (outcome || BILLING_INVALIDATING_ACTIONS.has(event.action)) {
				scheduleTrailingRefetch(
					queryClient,
					`billing:${workspaceId}`,
					{
						queryKey: queryKeys.billing.usage(workspaceId),
					},
					BILLING_REFETCH_MS,
				)
			}
			break
		}
		case 'integration':
			// A grant, a default, a connect or a disconnect: the integration list, the Keychain page
			// and every agent's access are all under this key, so they refresh together.
			invalidate(queryClient, { queryKey: queryKeys.integrations.all(workspaceId) })
			break
		case 'notification':
			invalidate(queryClient, { queryKey: queryKeys.notifications.all(workspaceId) })
			scheduleForYouRefetch(queryClient, workspaceId)
			break
		case 'actor':
		// A loop version update rewrites the loop's agents (name, description, tools) in place
		// and emits only an `installed_loop` event, never an `actor` one — so the agent list kept
		// the old name.
		case 'installed_loop':
			// Agents PATCH their own row as they work, so a busy minute is a burst of actor events.
			scheduleTrailingRefetch(
				queryClient,
				`actors:${workspaceId}`,
				{ queryKey: queryKeys.actors.all(workspaceId) },
				LIST_REFETCH_MS,
			)
			break
		case 'workspace':
			invalidate(queryClient, { queryKey: queryKeys.workspaces.all() })
			break
		case 'workspace_skill':
			// all() is a prefix of detail() so this covers both list and detail queries
			invalidate(queryClient, { queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			break
		case 'agent_skill':
			// The event's entity_id is the workspace-skill id; the target actorId is not in the
			// SSE payload, so invalidate all attachment queries in this tab with a broad prefix.
			invalidate(queryClient, { queryKey: ['agent-skill-attachments'] })
			break
		case 'file':
			// all() is a prefix of detail() so this covers both list and detail queries.
			invalidate(queryClient, { queryKey: queryKeys.files.all(workspaceId) })
			break
		case 'conversation':
			// Message posts also carry entity_type 'conversation' (entity_id is the
			// conversation, not the message) — detail(id) is a prefix of
			// messages(id, ...) so this one invalidation covers the thread's
			// detail, participants, and message pages too. It only touches that one
			// conversation, and only its mounted queries refetch, so it stays immediate.
			invalidate(queryClient, { queryKey: queryKeys.conversations.detail(event.entity_id) })
			// The chat list, reply threads and unread count sit under all(): one refetch per window.
			scheduleTrailingRefetch(
				queryClient,
				`chat-list:${workspaceId}`,
				{ queryKey: queryKeys.conversations.all(workspaceId) },
				LIST_REFETCH_MS,
			)
			break
		default:
			// Object types are workspace-defined, so an object event can carry any type name
			// (a LinkedIn post draft, an email) that the cases above do not list. Refresh the
			// object's own cache so a chat preview card follows an agent's edit. A key nobody
			// has cached is a no-op, so an event for a non-object entity costs nothing.
			invalidate(queryClient, { queryKey: queryKeys.objects.detail(event.entity_id) })
			break
	}
}
