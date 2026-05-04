import type { Page, Route } from '@playwright/test'

export interface SindreMockState {
	sessionId: string
	sindreActorId: string
	agents: Array<{ id: string; name: string }>
	objects: Array<{ id: string; title: string; type: string }>
	inputCalls: Array<{ content: string; attachments?: Array<{ kind: string; id: string }> }>
	sessionsCreated: number
	streamSubscriptions: number
}

export interface InstallSindreOpts {
	workspaceId: string
	humanActorId: string
	humanActorName: string
	/** Agents to expose in the actors list alongside the human and Sindre. */
	extraAgents?: Array<{ id: string; name: string }>
	/** Objects to expose for the `/` object picker. */
	objects?: Array<{ id: string; title: string; type: string }>
	/** Notifications to expose at `/api/notifications`. */
	notifications?: Array<Record<string, unknown>>
	sessionId?: string
	sindreActorId?: string
	/**
	 * Stdout JSON envelopes to deliver over the SSE logs stream on every
	 * subscription. Each entry becomes one `event: stdout\ndata: <json>\n\n`
	 * frame.
	 */
	streamEvents?: Array<Record<string, unknown>>
}

const DEFAULT_STREAM_EVENT = {
	type: 'assistant',
	message: {
		id: 'msg-e2e-1',
		content: [{ type: 'text', text: 'Hello from Sindre' }],
	},
}

/**
 * Installs Playwright route mocks for the Sindre-specific slice of the API
 * (actors, sessions, objects search, notifications) so E2E specs can
 * exercise the chat surfaces without a real Docker-backed interactive
 * session. Returns a mutable state object the test can assert against
 * after the run (sent input payloads, stream subscription count, etc).
 */
export async function installSindreMocks(
	page: Page,
	opts: InstallSindreOpts,
): Promise<SindreMockState> {
	const sessionId = opts.sessionId ?? 'e2e-sindre-session'
	const sindreActorId = opts.sindreActorId ?? 'e2e-sindre-actor'
	const agents = opts.extraAgents ?? []
	const objects = opts.objects ?? []
	const notifications = opts.notifications ?? []
	const streamEnvelopes =
		opts.streamEvents && opts.streamEvents.length > 0 ? opts.streamEvents : [DEFAULT_STREAM_EVENT]

	const state: SindreMockState = {
		sessionId,
		sindreActorId,
		agents,
		objects,
		inputCalls: [],
		sessionsCreated: 0,
		streamSubscriptions: 0,
	}

	// GET /api/actors — deterministic workspace roster: the test human,
	// Sindre, plus any extra agents the test seeded.
	await page.route('**/api/actors**', async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const url = new URL(route.request().url())
		// Skip nested actor routes (e.g. /api/actors/:id, /api/actors/:id/skills)
		// — only intercept the collection endpoint.
		if (!url.pathname.endsWith('/api/actors')) return route.fallback()

		const body = [
			{
				id: opts.humanActorId,
				type: 'human',
				name: opts.humanActorName,
				email: `${opts.humanActorId}@test.local`,
				is_system: false,
			},
			{
				id: sindreActorId,
				type: 'agent',
				name: 'Sindre',
				email: null,
				is_system: true,
			},
			...agents.map((a) => ({
				id: a.id,
				type: 'agent' as const,
				name: a.name,
				email: null,
				is_system: false,
			})),
		]

		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(body),
		})
	})

	// POST /api/sessions — interactive session bootstrap.
	await page.route('**/api/sessions', async (route: Route) => {
		const req = route.request()
		if (req.method() !== 'POST') return route.fallback()
		state.sessionsCreated += 1
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify(buildSessionResponse(sessionId, sindreActorId, opts.workspaceId)),
		})
	})

	// GET /api/sessions/:id — fetched by hooks after reload.
	await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(buildSessionResponse(sessionId, sindreActorId, opts.workspaceId)),
		})
	})

	// POST /api/sessions/:id/input — user turn delivery.
	await page.route(`**/api/sessions/${sessionId}/input`, async (route: Route) => {
		const req = route.request()
		if (req.method() !== 'POST') return route.fallback()
		try {
			const body = req.postDataJSON() as {
				content: string
				attachments?: Array<{ kind: string; id: string }>
			}
			state.inputCalls.push(body)
		} catch {
			// ignore non-JSON bodies
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true }),
		})
	})

	// GET /api/sessions/:id/logs/stream — SSE stream. Playwright's
	// route.fulfill can only emit a single (complete) response body, so we
	// pack all test envelopes into one body with a large `retry:` directive
	// so fetch-event-source holds off reconnecting after the body ends
	// (keeping the session hook's status at `ready` for the rest of the
	// test).
	await page.route(`**/api/sessions/${sessionId}/logs/stream`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		state.streamSubscriptions += 1
		const framed = streamEnvelopes
			.map((env) => `event: stdout\ndata: ${JSON.stringify(env)}\n\n`)
			.join('')
		const body = `retry: 600000\n\n${framed}`
		await route.fulfill({
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
			body,
		})
	})

	// GET /api/objects (empty-query picker fetch) and /api/objects/search.
	await page.route('**/api/objects**', async (route: Route) => {
		const req = route.request()
		if (req.method() !== 'GET') return route.fallback()
		const url = new URL(req.url())
		const pathname = url.pathname
		if (pathname.endsWith('/api/objects') || pathname.endsWith('/api/objects/search')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(
					objects.map((o) => ({
						id: o.id,
						type: o.type,
						title: o.title,
						content: null,
						status: 'active',
						metadata: null,
						owner: null,
						activeSessionId: null,
						createdBy: opts.humanActorId,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						workspaceId: opts.workspaceId,
					})),
				),
			})
			return
		}
		await route.fallback()
	})

	// GET /api/notifications — pre-seeded for the "Talk to Sindre" flow.
	await page.route('**/api/notifications**', async (route: Route) => {
		const req = route.request()
		if (req.method() !== 'GET') return route.fallback()
		const url = new URL(req.url())
		if (!url.pathname.endsWith('/api/notifications')) return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(notifications),
		})
	})

	return state
}

function buildSessionResponse(sessionId: string, sindreActorId: string, workspaceId: string) {
	const now = new Date().toISOString()
	return {
		id: sessionId,
		workspace_id: workspaceId,
		actor_id: sindreActorId,
		status: 'running',
		action_prompt: 'Sindre interactive chat',
		config: { interactive: true },
		interactive: true,
		trigger_id: null,
		created_by: sindreActorId,
		created_at: now,
		updated_at: now,
		started_at: now,
		stopped_at: null,
		error: null,
	}
}

export function buildNotificationFixture(params: {
	id: string
	workspaceId: string
	sourceActorId: string
	title: string
	content?: string
	type?: 'needs_input' | 'recommendation' | 'good_news' | 'alert'
}): Record<string, unknown> {
	const now = new Date().toISOString()
	return {
		id: params.id,
		workspaceId: params.workspaceId,
		type: params.type ?? 'recommendation',
		title: params.title,
		content: params.content ?? null,
		metadata: null,
		sourceActorId: params.sourceActorId,
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		createdAt: now,
		updatedAt: now,
	}
}
