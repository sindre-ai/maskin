import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { researchRuns, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, vi } from 'vitest'
import { createApiError, formatZodError, mapStatusToCode } from '../../lib/errors'
import { insertActor, insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const mocks = vi.hoisted(() => ({
	getModelPricing: vi.fn(),
	capture: vi.fn(),
	startSession: vi.fn(),
	stopSession: vi.fn(),
}))

// The price table, PostHog and the session start are the three things outside the process.
// Everything else here is real: Postgres, the routes, the idempotency layer, the flag, the
// plan cap and the session rows the watcher reads.
vi.mock('../../lib/openrouter-pricing', async (orig) => ({
	...(await orig<typeof import('../../lib/openrouter-pricing')>()),
	getModelPricing: mocks.getModelPricing,
}))
vi.mock('../../lib/analytics/posthog', async (orig) => ({
	...(await orig<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: mocks.capture,
}))
vi.mock('../../services/session-lifecycle', async (orig) => ({
	...(await orig<typeof import('../../services/session-lifecycle')>()),
	startSession: mocks.startSession,
}))

const { PlanCapExceededError } = await import('../../lib/llm-routing')
const { _resetFeatureFlagConfig } = await import('../../lib/feature-flags')
const { createIdempotencyMiddleware } = await import('../../middleware/idempotency')
const { default: researchRoutes } = await import('../../routes/research')
const {
	__resetResearchSlotsForTesting,
	markInterruptedResearchRuns,
	parseSources,
	startResearchRun,
} = await import('../../services/research-service')

const REPORT = [
	'## TL;DR',
	'Accounting records must be kept for five years [1].',
	'',
	'## Sources',
	'[1] Bogføringsloven, Retsinformation, 2022-05-24. https://www.retsinformation.dk/eli/lta/2022/700',
	'',
	'## Method',
	'1 researcher.',
].join('\n')

const MODEL = 'anthropic/claude-haiku-4.5'

type RunBody = {
	status: string
	report_md: string | null
	sources: Array<{ n: number; url: string | null }>
	cap: { cap_cents: number }
	route: string | null
	model: string | null
	session_id: string | null
	error: string | null
	usage: { cost_cents: number; tokens_in: number; tokens_out: number }
}

type Env = {
	Variables: {
		db: Database
		actorId: string
		workspaceRole?: string
		sessionManager: { stopSession: typeof mocks.stopSession }
	}
}

function createResearchApp(actorId: string, role?: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('sessionManager', { stopSession: mocks.stopSession })
		if (role) c.set('workspaceRole', role)
		await next()
	})
	// The same shared layer the real app puts in front of every /api route.
	app.use('*', createIdempotencyMiddleware(db))
	app.onError((err, c) => {
		if (err instanceof PlanCapExceededError) {
			return c.json({ error: { code: 'PLAN_CAP_EXCEEDED', message: err.message } }, 402)
		}
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
	})
	app.route('/api/research', researchRoutes)
	return app
}

const ENV_KEYS = ['FF_TESTER_ACTOR_IDS', 'FF_TESTER_FEATURES', 'MASKIN_FALLBACK_OPENROUTER_KEY']

const customEndpoint = {
	enabled: true,
	base_url: 'https://openrouter.ai/api',
	api_key: 'sealed-test-key',
	model: MODEL,
}

describe('deep_research routes (Integration)', () => {
	let actorId: string
	let agentId: string
	let workspaceId: string
	let app: ReturnType<typeof createResearchApp>
	const savedEnv: Record<string, string | undefined> = {}

	function enableFlag(on: boolean) {
		process.env.FF_TESTER_ACTOR_IDS = actorId
		process.env.FF_TESTER_FEATURES = on ? 'deep-research' : ''
		_resetFeatureFlagConfig()
	}

	/** What the real session start does for the run: a session row on the research agent. */
	async function sessionRow(status: string, overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, agentId, actorId, {
			status,
			modelName: MODEL,
			...overrides,
		})
	}

	/** A research session that has already ended with a report, a cost and a result message. */
	async function finishedSession(
		over: { result?: Record<string, unknown>; status?: string; cost?: string } = {},
	) {
		const row = await sessionRow(over.status ?? 'completed', {
			totalCostUsd: over.cost ?? '0.123400',
			inputTokens: 5000,
			outputTokens: 800,
		})
		const envelope = {
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: REPORT,
			total_cost_usd: 0.1,
			usage: { input_tokens: 5000, output_tokens: 800 },
			...over.result,
		}
		await insertSessionLog(db, row.id, {
			stream: 'stdout',
			content: `${JSON.stringify(envelope)}\n`,
		})
		return row
	}

	beforeEach(async () => {
		for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
		actorId = getTestActorId()
		enableFlag(true)
		for (const m of Object.values(mocks)) m.mockReset()
		mocks.getModelPricing.mockResolvedValue({
			prompt: 1e-6,
			completion: 5e-6,
			cacheRead: 0,
			cacheWrite: 0,
		})
		mocks.stopSession.mockResolvedValue(undefined)
		__resetResearchSlotsForTesting()
		// A workspace with its own custom endpoint and a research agent, like the real set-up.
		const ws = await insertWorkspace(db, actorId, { settings: { custom_llm: customEndpoint } })
		workspaceId = ws.id
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Research agent',
			metadata: { deep_research_agent: true },
		})
		agentId = agent.id
		// insertSession makes the agent a member of the workspace, which is how the run finds it.
		await insertSession(db, workspaceId, agentId, actorId, { status: 'completed' })
		// By default a started session has already ended with a report, so a run settles at once.
		mocks.startSession.mockImplementation(async () => ({ sessionId: (await finishedSession()).id }))
		app = createResearchApp(actorId)
	})

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k]
			else process.env[k] = savedEnv[k]
		}
		_resetFeatureFlagConfig()
	})

	const post = (
		body: Record<string, unknown>,
		opts: { key?: string | null; ws?: string; app?: typeof app } = {},
	) => {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'x-workspace-id': opts.ws ?? workspaceId,
		}
		if (opts.key !== null) headers['idempotency-key'] = opts.key ?? crypto.randomUUID()
		return (opts.app ?? app).request('/api/research', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	}
	const get = (id: string, a: typeof app = app) =>
		a.request(`/api/research/${id}`, { headers: { 'x-workspace-id': workspaceId } })

	const question = { question: 'Hvor længe skal bogføringsmateriale opbevares?', effort: 'simple' }

	const rowsInWorkspace = async () =>
		db.select().from(researchRuns).where(eq(researchRuns.workspaceId, workspaceId))

	async function waitForEnd(id: string): Promise<RunBody> {
		for (let i = 0; i < 250; i++) {
			const body = (await (await get(id)).json()) as { status: string }
			if (body.status !== 'queued' && body.status !== 'running') return body as RunBody
			await new Promise((r) => setTimeout(r, 20))
		}
		throw new Error('the run did not finish')
	}

	const finishedEvents = () =>
		mocks.capture.mock.calls.filter((c) => c[0] === 'deep_research_run_finished')

	it('returns 202 with an id, and the finished run has the report, cost, route, model and session id', async () => {
		const res = await post(question)
		expect(res.status).toBe(202)
		const { id } = (await res.json()) as { id: string }

		const run = await waitForEnd(id)
		expect(run.status).toBe('done')
		expect(run.report_md).toBe(REPORT)
		expect(run.sources).toEqual([
			{
				n: 1,
				text: 'Bogføringsloven, Retsinformation, 2022-05-24. https://www.retsinformation.dk/eli/lta/2022/700',
				url: 'https://www.retsinformation.dk/eli/lta/2022/700',
			},
		])
		expect(run.cap).toEqual({ cap_cents: 100 })
		expect(run.route).toBe('workspace_custom')
		expect(run.model).toBe(MODEL)
		expect(run.session_id).toBeTruthy()
		// $0.1234 from the session, rounded up to whole cents.
		expect(run.usage).toEqual({ cost_cents: 13, tokens_in: 5000, tokens_out: 800 })
	})

	it('starts one session on the research agent, pinned to the custom endpoint, with no Maskin key in the prompt', async () => {
		const { id } = (await (await post(question)).json()) as { id: string }
		await waitForEnd(id)

		expect(mocks.startSession).toHaveBeenCalledTimes(1)
		const input = mocks.startSession.mock.calls[0]?.[0]
		expect(input).toMatchObject({
			workspaceId,
			actorId: agentId,
			callerKind: 'internal',
			config: { pin_llm_route: 'workspace_custom', research_run_id: id },
		})
		expect(input.actionPrompt).toContain('deep-research skill')
		expect(input.actionPrompt).toContain(question.question)
	})

	it('fires deep_research_run_finished once, with the agreed properties', async () => {
		const { id } = (await (await post(question)).json()) as { id: string }
		const run = await waitForEnd(id)

		const events = finishedEvents()
		expect(events).toHaveLength(1)
		const [, distinctId, props] = events[0] as [string, string, Record<string, unknown>]
		expect(distinctId).toBe(actorId)
		expect(props).toEqual({
			workspace_id: workspaceId,
			effort: 'simple',
			status: 'done',
			cost_cents: run.usage.cost_cents,
			cap_cents: 100,
			duration: expect.any(Number),
			route: 'workspace_custom',
			model: MODEL,
		})
		// No question or report ever leaves the process.
		expect(JSON.stringify(props)).not.toContain('bogføring')
	})

	describe('how the session ends', () => {
		it('fails the run with the session reason when the session failed', async () => {
			mocks.startSession.mockImplementation(async () => {
				const row = await sessionRow('failed', {
					result: { failure_reason: { human_message: 'Out of credit on the endpoint.' } },
				})
				return { sessionId: row.id }
			})
			const { id } = (await (await post(question)).json()) as { id: string }
			const run = await waitForEnd(id)
			expect(run.status).toBe('failed')
			expect(run.error).toBe('Out of credit on the endpoint.')
			expect(run.report_md).toBeNull()
		})

		it('fails the run when the last result message is an error', async () => {
			mocks.startSession.mockImplementation(async () => ({
				sessionId: (
					await finishedSession({
						result: { is_error: true, result: 'API Error: model not found' },
					})
				).id,
			}))
			const { id } = (await (await post(question)).json()) as { id: string }
			const run = await waitForEnd(id)
			expect(run.status).toBe('failed')
			expect(run.error).toBe('API Error: model not found')
		})

		it('fails the run when the session ended without any result message', async () => {
			mocks.startSession.mockImplementation(async () => ({
				sessionId: (await sessionRow('completed')).id,
			}))
			const { id } = (await (await post(question)).json()) as { id: string }
			const run = await waitForEnd(id)
			expect(run.status).toBe('failed')
			expect(run.error).toContain('without a report')
		})

		it('stops a session that is still going at the deadline and fails the run', async () => {
			const running = await sessionRow('running')
			let settled: () => void = () => {}
			const done = new Promise<void>((resolve) => {
				settled = resolve
			})
			const started = await startResearchRun(
				{
					db,
					sessionManager: { stopSession: mocks.stopSession },
					actorId,
					workspaceId,
					question: question.question,
					context: null,
					effort: 'simple',
				},
				{
					startSession: async () => ({ sessionId: running.id }),
					lookupPricing: mocks.getModelPricing,
					pollIntervalMs: 10,
					deadlineMs: 30,
					stopGraceMs: 60,
					onRunSettled: () => settled(),
				},
			)
			await done

			expect(mocks.stopSession).toHaveBeenCalledWith(running.id)
			const [row] = await db.select().from(researchRuns).where(eq(researchRuns.id, started.id))
			expect(row?.status).toBe('failed')
			expect(row?.error).toContain('20 minute limit')
			expect(row?.sessionId).toBe(running.id)
		})
	})

	describe('Idempotency-Key', () => {
		it('is required', async () => {
			const res = await post(question, { key: null })
			expect(res.status).toBe(400)
			expect(await rowsInWorkspace()).toHaveLength(0)
		})

		it('gives one run row and one session for two POSTs with the same key, one after the other', async () => {
			const key = crypto.randomUUID()
			const first = (await (await post(question, { key })).json()) as { id: string }
			const second = await post(question, { key })
			expect(second.status).toBe(202)
			expect(((await second.json()) as { id: string }).id).toBe(first.id)
			expect(await rowsInWorkspace()).toHaveLength(1)
			await waitForEnd(first.id)
			expect(mocks.startSession).toHaveBeenCalledTimes(1)
		})

		it('gives one run row and one session for two POSTs with the same key at the same time', async () => {
			const key = crypto.randomUUID()
			const [a, b] = await Promise.all([post(question, { key }), post(question, { key })])
			const ids = [((await a.json()) as { id: string }).id, ((await b.json()) as { id: string }).id]
			expect(ids[0]).toBe(ids[1])
			expect(await rowsInWorkspace()).toHaveLength(1)
			await waitForEnd(ids[0] as string)
			expect(mocks.startSession).toHaveBeenCalledTimes(1)
		})
	})

	describe('refusals that create no row and start no session', () => {
		afterEach(async () => {
			expect(await rowsInWorkspace()).toHaveLength(0)
			expect(mocks.startSession).not.toHaveBeenCalled()
		})

		it('answers not enabled when the flag is off for the caller', async () => {
			enableFlag(false)
			const res = await post(question)
			expect(res.status).toBe(403)
			expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
				'not enabled',
			)
		})

		it('refuses a viewer', async () => {
			const res = await post(question, { app: createResearchApp(actorId, 'viewer') })
			expect(res.status).toBe(403)
		})

		it('rejects an unknown effort as a validation error', async () => {
			const res = await post({ ...question, effort: 'huge' })
			expect(res.status).toBe(400)
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'VALIDATION_ERROR',
			)
		})

		it('gives a plain error when the workspace has no custom endpoint, only a key or a subscription', async () => {
			const bare = await insertWorkspace(db, actorId, {
				settings: { llm_keys: { anthropic: 'sk-ant-test' } },
			})
			const res = await post(question, { ws: bare.id })
			expect(res.status).toBe(400)
			const message = ((await res.json()) as { error: { message: string } }).error.message
			expect(message).toContain('custom model endpoint')
			expect(message).toContain('Claude subscription')
			const rows = await db.select().from(researchRuns).where(eq(researchRuns.workspaceId, bare.id))
			expect(rows).toHaveLength(0)
		})

		it('refuses a custom endpoint that is switched off', async () => {
			const off = await insertWorkspace(db, actorId, {
				settings: { custom_llm: { ...customEndpoint, enabled: false } },
			})
			const res = await post(question, { ws: off.id })
			expect(res.status).toBe(400)
		})

		it('refuses to start on a model with no price', async () => {
			mocks.getModelPricing.mockResolvedValue(null)
			const res = await post(question)
			expect(res.status).toBe(400)
			expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
				'has no price',
			)
			expect(mocks.getModelPricing).toHaveBeenCalledWith(MODEL)
		})

		it('answers 503 when the workspace has no research agent', async () => {
			const noAgent = await insertWorkspace(db, actorId, {
				settings: { custom_llm: customEndpoint },
			})
			const res = await post(question, { ws: noAgent.id })
			expect(res.status).toBe(503)
			expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
				'no research agent',
			)
		})
	})

	it('starts no session-less run: when the session start fails the caller gets the error and no row stays', async () => {
		mocks.startSession.mockRejectedValue(new Error('no credentials'))
		const res = await post(question)
		expect(res.status).toBe(500)
		expect(await rowsInWorkspace()).toHaveLength(0)
	})

	describe('GET /api/research/:id', () => {
		it('answers 404 for a run in a workspace the caller is not in, and for an unknown id', async () => {
			const stranger = await insertActor(db, { type: 'human', name: 'Stranger' })
			const theirWs = await insertWorkspace(db, stranger.id, {})
			const [theirRun] = await db
				.insert(researchRuns)
				.values({
					workspaceId: theirWs.id,
					actorId: stranger.id,
					question: 'secret question',
					effort: 'simple',
					capCents: 100,
					status: 'done',
					reportMd: 'secret report',
				})
				.returning()
			if (!theirRun) throw new Error('insert failed')

			const res = await get(theirRun.id)
			expect(res.status).toBe(404)
			expect(JSON.stringify(await res.json())).not.toContain('secret')
			expect((await get(crypto.randomUUID())).status).toBe(404)
		})

		it('is behind the flag too', async () => {
			enableFlag(false)
			expect((await get(crypto.randomUUID())).status).toBe(403)
		})
	})

	it('allows two runs at once in a workspace and answers 429 to a third', async () => {
		// Sessions that never end keep both slots taken.
		const running = await sessionRow('running')
		mocks.startSession.mockImplementation(async () => ({ sessionId: running.id }))

		const a = (await (await post(question)).json()) as { id: string }
		const b = (await (await post(question)).json()) as { id: string }
		const third = await post(question)
		expect(third.status).toBe(429)
		expect(await rowsInWorkspace()).toHaveLength(2)

		// Both runs end when their session does, and a slot is free again.
		await db.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, running.id))
		await waitForEnd(a.id)
		await waitForEnd(b.id)
		mocks.startSession.mockImplementation(async () => ({ sessionId: (await finishedSession()).id }))
		const fourth = await post(question)
		expect(fourth.status).toBe(202)
		await waitForEnd(((await fourth.json()) as { id: string }).id)
	})

	describe('runs left behind by a restart', () => {
		it('marks queued and running runs interrupted, keeps their cost, stops their session, and leaves finished runs alone', async () => {
			const live = await sessionRow('running')
			const insertRun = async (status: string, costCents: number, sessionId?: string) => {
				const [row] = await db
					.insert(researchRuns)
					.values({
						workspaceId,
						actorId,
						question: 'q',
						effort: 'comparison',
						capCents: 400,
						status,
						costCents,
						sessionId,
					})
					.returning({ id: researchRuns.id })
				return row?.id as string
			}
			const queued = await insertRun('queued', 0)
			const running = await insertRun('running', 37, live.id)
			const done = await insertRun('done', 12)
			const capped = await insertRun('capped', 400)

			const marked = await markInterruptedResearchRuns(db, { stopSession: mocks.stopSession })
			expect(marked).toBeGreaterThanOrEqual(2)
			expect(mocks.stopSession).toHaveBeenCalledWith(live.id)

			const rows = await db
				.select()
				.from(researchRuns)
				.where(eq(researchRuns.workspaceId, workspaceId))
			const byId = new Map(rows.map((r) => [r.id, r]))
			expect(byId.get(queued)?.status).toBe('interrupted')
			expect(byId.get(running)).toMatchObject({ status: 'interrupted', costCents: 37 })
			expect(byId.get(running)?.finishedAt).not.toBeNull()
			expect(byId.get(running)?.error).toContain('restarted')
			expect(byId.get(done)).toMatchObject({ status: 'done', costCents: 12 })
			expect(byId.get(capped)).toMatchObject({ status: 'capped', costCents: 400 })

			// The caller sees it as an ended run with its cost.
			const view = (await (await get(running)).json()) as RunBody
			expect(view.status).toBe('interrupted')
			expect(view.usage.cost_cents).toBe(37)
		})
	})
})

describe('parseSources', () => {
	it('reads the numbered entries under the Sources heading and stops at the next heading', () => {
		const md =
			'## Sources\n[1] A, B, 2026. https://a.example/x\n2. Plain entry\n\n## Method\n[3] not a source'
		expect(parseSources(md)).toEqual([
			{ n: 1, text: 'A, B, 2026. https://a.example/x', url: 'https://a.example/x' },
			{ n: 2, text: 'Plain entry', url: null },
		])
	})

	it('is empty when the report has no Sources section', () => {
		expect(parseSources('## TL;DR\nNothing.')).toEqual([])
	})
})
