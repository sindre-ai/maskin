import { type Page, expect } from '@playwright/test'
import { E2E_AGENT_SERVER_SECRET, type TestAPI } from './api.helper'
import { grantPlanHeadroom } from './plan.helper'

/**
 * Shared setup for the SSE log-stream hardening specs
 * (reconnect / session-completion / backgrounded-tab).
 *
 * All three specs need the same fixture: a real `pending` session row presented
 * to the UI as `running`, anchored to a real conversation message so the live
 * turn renders. The log lines are real too — they go through the production
 * ingest endpoint (`POST /api/internal/agent-servers/sessions/:id/logs`), which
 * inserts them and emits on the in-process `log` bus the SSE handler reads.
 *
 * The three specs differ only in what they instrument between seeding the
 * session and opening the chat, so seeding and opening are separate calls.
 */

/** A `tool_use` assistant envelope whose transcript step summary is `Using <name>`. */
export function toolUseLine(name: string, id = `toolu_${name}`): string {
	return JSON.stringify({
		type: 'assistant',
		message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }] },
	})
}

/** A `thinking` assistant envelope whose transcript step summary is `Thinking…`. */
export function thinkingLine(id = 'think_1'): string {
	return JSON.stringify({
		type: 'assistant',
		message: { id: `msg_${id}`, content: [{ type: 'thinking', thinking: 'Weighing options' }] },
	})
}

/**
 * The `user` envelope carrying `maskin_message_id` is the only thing that opens
 * a new activity segment (`segmentActivityByMessage` pushes a segment and
 * returns on it). Without it the assistant lines land in `unassigned` and the
 * live turn never anchors to a conversation message.
 *
 * The newest stdout envelope must also NOT end in a `result`, or
 * `isSessionIdleAwaitingInput` reads the session as idle and the live turn is
 * suppressed — hence no result line anywhere in these specs.
 */
export function userLine(conversationMessageId: number): string {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'Kick off the live turn' },
		maskin_message_id: conversationMessageId,
	})
}

/** Structural subset of the auth fixture's `account`, so the helper need not import the fixture. */
export interface StreamAccount {
	apiKey: string
	workspaceId: string
	api: TestAPI
}

export interface LiveChatSession {
	sessionId: string
	conversationId: string
	triggerMessageId: number
	agentId: string
}

/**
 * Seed a live chat session: agent + conversation + trigger message + a session
 * row left in `pending` (`auto_start: false`, so no container is ever launched),
 * plus the route mock that presents that row as `running`.
 *
 * The mock's glob is `** /api/sessions*` and its `*` stops at the first `/`, so
 * `/api/sessions/:id/logs` and `/api/sessions/:id/logs/stream` still reach the
 * real API — that is what makes the poll/SSE counting in these specs meaningful.
 *
 * The filtering inside the mock is load-bearing, not tidiness. Posting the
 * trigger message runs `evaluateAndRespond`, which spawns a real interactive
 * session for the same (conversation, agent) pair. In this stack that session
 * fails instantly (no LLM credentials), and the transcript keeps only the
 * NEWEST session per actor — so the responder's failed row can outrank the
 * seeded one and render the "failed to start" card instead of the live turn.
 * The two rows are created ~3ms apart, so leaving both visible is a coin flip.
 *
 * Deliberately does NOT navigate — callers instrument `page.on('request')`
 * between seeding and `openLiveChat` so the initial SSE connection is counted.
 */
export async function seedLiveChatSession(
	page: Page,
	account: StreamAccount,
	title: string,
): Promise<LiveChatSession> {
	// A trial workspace caps seats; the agent must join as a member for the
	// conversation to route a turn to it.
	await grantPlanHeadroom(account.apiKey, account.workspaceId)
	const agent = await account.api.createAgentActor(`E2E Stream Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)

	const conversation = await account.api.createConversation(account.workspaceId, {
		title,
		participant_actor_ids: [agent.id],
	})
	const trigger = await account.api.postConversationMessage(conversation.id, account.workspaceId, {
		content: 'Start the live turn',
	})

	const session = await account.api.createSession(account.workspaceId, {
		actor_id: agent.id,
		action_prompt: 'SSE log stream hardening E2E',
		config: { conversation: { conversation_id: conversation.id, message_id: trigger.id } },
		auto_start: false,
	})

	await page.route('**/api/sessions*', async (route) => {
		const response = await route.fetch()
		let body: unknown
		try {
			body = await response.json()
		} catch {
			await route.fulfill({ response })
			return
		}
		const sessions = Array.isArray(body) ? body : []
		await route.fulfill({
			response,
			json: sessions
				.filter((s) => (s as { id?: string }).id === session.id)
				.map((s) => ({ ...(s as Record<string, unknown>), status: 'running' })),
		})
	})

	return {
		sessionId: session.id,
		conversationId: conversation.id,
		triggerMessageId: trigger.id,
		agentId: agent.id,
	}
}

/** Navigate to the seeded chat and return the live-turn activity anchors. */
export async function openLiveChat(
	page: Page,
	account: StreamAccount,
	live: LiveChatSession,
	title: string,
) {
	await page.goto(`/${account.workspaceId}/chats/${live.conversationId}`)
	await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 })
	const liveTurn = page.getByTestId('message-activity-live')
	return { liveTurn, activitySteps: liveTurn.getByLabel('Agent activity') }
}

/**
 * Endpoints owned by queries that must NOT refetch on a focus event — the
 * negative half of the focus-scoping acceptance criterion.
 *
 * `useObjects` and `useBillingUsage` are genuinely mounted on the chat route
 * (via the command palette and the trial banner), so those two are a real
 * assertion here. `useEvents` and `useNotifications` are not mounted on this
 * route, so their absence from this list is expected regardless of the fix —
 * the unit test's QueryClient-cache assertion is the authority for those two.
 */
const UNRELATED_PATHS = ['/api/objects', '/api/events', '/api/notifications', '/api/billing']

export interface RequestCounts {
	sse: number
	poll: number
	unrelated: Map<string, number>
	/** `Last-Event-ID` sent on each stream request, in order. */
	streamCursors: string[]
}

/**
 * Count requests to the session's SSE stream, the session's poll endpoint, and
 * every unrelated endpoint, for the lifetime of the page.
 *
 * The stream and poll URLs differ only by a trailing `/stream`, so the stream
 * check has to come first — otherwise every SSE request would also be counted
 * as a poll.
 *
 * The stream request's `Last-Event-ID` header is captured alongside the count:
 * it is the client's persisted resume cursor, and its presence on a *re*
 * connect is what makes the server replay the rows missed while the stream was
 * down. A reconnect that arrives without it would silently restart from the
 * live edge and drop the gap.
 */
export function countSessionRequests(page: Page, sessionId: string) {
	const counts: RequestCounts = { sse: 0, poll: 0, unrelated: new Map(), streamCursors: [] }

	page.on('request', (req) => {
		const url = req.url()
		if (url.includes(`/sessions/${sessionId}/logs/stream`)) {
			counts.sse += 1
			counts.streamCursors.push(req.headers()['last-event-id'] ?? '')
			return
		}
		if (url.includes(`/sessions/${sessionId}/logs`)) {
			counts.poll += 1
			return
		}
		for (const path of UNRELATED_PATHS) {
			if (url.includes(path)) {
				counts.unrelated.set(path, (counts.unrelated.get(path) ?? 0) + 1)
			}
		}
	})

	return {
		counts,
		reset() {
			counts.sse = 0
			counts.poll = 0
			counts.unrelated.clear()
			counts.streamCursors = []
		},
		unrelatedTotal() {
			return [...counts.unrelated.values()].reduce((a, b) => a + b, 0)
		},
		/** The `Last-Event-ID` on the most recent stream request, or null if none carried one. */
		lastStreamCursor(): string | null {
			return counts.streamCursors.at(-1) ?? null
		},
		unrelatedDetail() {
			return [...counts.unrelated.entries()].map(([p, n]) => `${p}×${n}`).join(', ') || 'none'
		},
	}
}

/**
 * The client's persisted resume cursor for a session, read straight from
 * `sessionStorage`.
 *
 * `session-log-stream.ts` writes it under
 * `maskin-last-session-log-id-${sessionId}` on every received row and reads it
 * back on connect to send `Last-Event-ID`. It living in `sessionStorage` (not a
 * module variable) is what lets it survive a full page navigation — which is
 * exactly the property a reconnect after a real drop depends on.
 */
export async function readPersistedCursor(page: Page, sessionId: string): Promise<string | null> {
	return page.evaluate(
		(id) => sessionStorage.getItem(`maskin-last-session-log-id-${id}`),
		sessionId,
	)
}

/**
 * Post distinct heartbeat rows until the client's resume cursor appears, then
 * return it (null if every name timed out).
 *
 * The log route replays rows only when a `Last-Event-ID` cursor is present; a
 * stream that connects *after* a post joins the live bus and never sees that
 * post (apps/dev/src/routes/sessions.ts:845-863). So the first connection can
 * lose the race against the first post — observed at 375px, where the warm-up
 * row arrived by poll and the stream had delivered nothing. Posting another
 * row once the stream is up is what closes that gap.
 *
 * The cursor is written by the stream alone — `sse.ts` sets it on every frame
 * carrying an id, and the poll never touches it — so a non-null cursor is
 * proof the stream delivered at least one row.
 *
 * Each name must be distinct: the transcript renders one step per `tool_use`,
 * and the specs assert each renders exactly once.
 */
export async function warmUpStream(
	page: Page,
	account: StreamAccount,
	sessionId: string,
	names: string[],
): Promise<string | null> {
	let cursor: string | null = null
	for (const name of names) {
		await account.api.postSessionLogs(
			sessionId,
			[{ stream: 'stdout', content: toolUseLine(name) }],
			E2E_AGENT_SERVER_SECRET,
		)
		const deadline = Date.now() + 8_000
		for (;;) {
			cursor = await readPersistedCursor(page, sessionId)
			if (cursor) return cursor
			if (Date.now() >= deadline) break
			await page.waitForTimeout(400)
		}
	}
	return cursor
}

/**
 * Drive `document.visibilityState` from the test, the way a backgrounded tab
 * would. TanStack's `focusManager` listens for `visibilitychange` on `window`
 * and reads `document.visibilityState` when deciding whether the page is
 * focused, so overriding the getter is what makes the page unfocused to it.
 *
 * `visibilityState` and `hidden` live on `Document.prototype`, so they are
 * shadowed with own properties on the instance; both are configurable so the
 * restore call can hand the real getters back.
 */
export async function setPageVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
	await page.evaluate((next) => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => next,
		})
		Object.defineProperty(document, 'hidden', {
			configurable: true,
			get: () => next === 'hidden',
		})
		window.dispatchEvent(new Event('visibilitychange'))
	}, state)
}
