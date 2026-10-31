import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { researchRuns } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, vi } from 'vitest'
import { createApiError, formatZodError, mapStatusToCode } from '../../lib/errors'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const mocks = vi.hoisted(() => {
	const URL_A = 'https://www.retsinformation.dk/eli/lta/2022/700'
	return {
		URL_A,
		chat: vi.fn(),
		getModelPricing: vi.fn(),
		capture: vi.fn(),
		provider: {
			name: 'fake',
			searchPriceMicroUsd: 8_000,
			extractUrlPriceMicroUsd: 1_600,
			search: async () => ({
				hits: [
					{
						title: 'Bogføringsloven',
						url: URL_A,
						snippet: 'Loven om bogføring',
						publishedDate: '2022-05-24',
					},
				],
				costMicroUsd: 8_000,
			}),
			extract: async (urls: string[]) => ({
				pages: urls.map((url) => ({
					url,
					text: 'Regnskabsmateriale skal opbevares i fem år efter regnskabsårets udløb.',
				})),
				failed: [],
				costMicroUsd: urls.length * 1_600,
			}),
		},
	}
})

// The model, the price table, the search provider and PostHog are the four things
// outside the process. Everything else here is real: Postgres, the routes, the
// idempotency layer, the flag and the plan cap.
vi.mock('../../lib/llm/index', () => ({ createLLMAdapter: () => ({ chat: mocks.chat }) }))
vi.mock('../../lib/openrouter-pricing', async (orig) => ({
	...(await orig<typeof import('../../lib/openrouter-pricing')>()),
	getModelPricing: mocks.getModelPricing,
}))
vi.mock('../../lib/research/tavily', async (orig) => ({
	...(await orig<typeof import('../../lib/research/tavily')>()),
	tavilyProviderFromEnv: () => mocks.provider,
}))
vi.mock('../../lib/analytics/posthog', async (orig) => ({
	...(await orig<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: mocks.capture,
}))

const { PlanCapExceededError } = await import('../../lib/llm-routing')
const { _resetFeatureFlagConfig } = await import('../../lib/feature-flags')
const { createIdempotencyMiddleware } = await import('../../middleware/idempotency')
const { default: researchRoutes } = await import('../../routes/research')
const { __resetResearchSlotsForTesting } = await import('../../services/research-service')

const QUOTE = 'Regnskabsmateriale skal opbevares i fem år efter regnskabsårets udløb.'
const usage = (input: number, output: number) => ({
	input_tokens: input,
	output_tokens: output,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
})
const toolTurn = (name: string, args: Record<string, unknown>, tokens = usage(1500, 40)) => ({
	content: null,
	tool_calls: [{ id: `call-${name}`, name, arguments: args }],
	finish_reason: 'tool_calls' as const,
	usage: tokens,
})
const textTurn = (content: string, tokens = usage(1000, 200)) => ({
	content,
	tool_calls: [],
	finish_reason: 'stop' as const,
	usage: tokens,
})
const finding = {
	claim: 'Materialet opbevares i fem år.',
	quote: QUOTE,
	url: mocks.URL_A,
	title: 'Bogføringsloven',
	publisher: 'Retsinformation',
	date: '2022-05-24',
	source_type: 'primary',
	confidence: 0.9,
}

/** The four model turns of a full simple run: search, read, report findings, write. */
function scriptFullRun() {
	mocks.chat
		.mockResolvedValueOnce(toolTurn('web_search', { query: 'bogføringsloven opbevaring' }))
		.mockResolvedValueOnce(toolTurn('web_fetch', { urls: [mocks.URL_A] }, usage(1800, 40)))
		.mockResolvedValueOnce(
			textTurn(JSON.stringify({ findings: [finding], unread: [], gaps: [] }), usage(3000, 400)),
		)
		.mockResolvedValueOnce(
			textTurn(
				'## TL;DR\nMaterialet opbevares i fem år [1].\n\n## Confidence\nHøj.',
				usage(900, 150),
			),
		)
}

type RunBody = {
	status: string
	report_md: string
	sources: Array<{ url: string }>
	warnings: unknown[]
	cap: { cap_cents: number }
	usage: { cost_cents: number; searches: number; extracts: number }
}

type Env = { Variables: { db: Database; actorId: string; workspaceRole?: string } }

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

describe('deep_research routes (Integration)', () => {
	let actorId: string
	let workspaceId: string
	let app: ReturnType<typeof createResearchApp>
	const savedEnv: Record<string, string | undefined> = {}

	function enableFlag(on: boolean) {
		process.env.FF_TESTER_ACTOR_IDS = actorId
		process.env.FF_TESTER_FEATURES = on ? 'deep-research' : ''
		_resetFeatureFlagConfig()
	}

	beforeEach(async () => {
		for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
		actorId = getTestActorId()
		enableFlag(true)
		mocks.chat.mockReset()
		mocks.capture.mockReset()
		mocks.getModelPricing.mockReset()
		mocks.getModelPricing.mockResolvedValue({
			prompt: 1e-6,
			completion: 5e-6,
			cacheRead: 0,
			cacheWrite: 0,
		})
		__resetResearchSlotsForTesting()
		// A workspace with its own Anthropic key: the run is allowed and not on the plan cap.
		const ws = await insertWorkspace(db, actorId, {
			settings: { llm_keys: { anthropic: 'sk-ant-test' } },
		})
		workspaceId = ws.id
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

	it('returns 202 with an id, and the finished run has a cited report, a Method section and a cost', async () => {
		scriptFullRun()
		const res = await post(question)
		expect(res.status).toBe(202)
		const { id } = (await res.json()) as { id: string }

		const run = await waitForEnd(id)
		expect(run.status).toBe('done')
		expect(run.report_md).toContain('[1]')
		expect(run.report_md).toContain('## Method')
		expect(run.sources).toHaveLength(1)
		expect(run.sources[0].url).toBe(mocks.URL_A)
		expect(run.cap).toEqual({ cap_cents: 100 })
		expect(run.usage.searches).toBe(1)
		expect(run.usage.extracts).toBe(1)
		expect(run.usage.cost_cents).toBeGreaterThan(0)
		expect(run.usage.cost_cents).toBeLessThanOrEqual(100)
		expect(run.warnings).toEqual([])
	})

	it('fires deep_research_run_finished once, with the agreed properties', async () => {
		scriptFullRun()
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
			searches: 1,
			extracts: 1,
			duration: expect.any(Number),
			researchers: 1,
			tier12_share: 1,
		})
		// No question, report or quote ever leaves the process.
		expect(JSON.stringify(props)).not.toContain('bogføring')
	})

	it('ends a $0.05 run as capped, under the cap, with a warning at the top of the report', async () => {
		mocks.chat
			.mockResolvedValueOnce(toolTurn('web_search', { query: 'x' }, usage(6000, 40)))
			.mockResolvedValueOnce(
				textTurn(
					JSON.stringify({ findings: [], unread: [], gaps: ['no page was read'] }),
					usage(1500, 100),
				),
			)
			.mockResolvedValueOnce(textTurn('## TL;DR\nNo source found.', usage(500, 50)))

		const { id } = (await (await post({ ...question, max_cost_usd: 0.05 })).json()) as {
			id: string
		}
		const run = await waitForEnd(id)

		expect(run.status).toBe('capped')
		expect(run.cap).toEqual({ cap_cents: 5 })
		expect(run.usage.cost_cents).toBeLessThanOrEqual(5)
		expect(run.report_md.startsWith('> **Warning:**')).toBe(true)
		const events = finishedEvents()
		expect(events).toHaveLength(1)
		expect((events[0] as unknown[])[2]).toMatchObject({ status: 'capped', cap_cents: 5 })
	})

	describe('Idempotency-Key', () => {
		it('is required', async () => {
			const res = await post(question, { key: null })
			expect(res.status).toBe(400)
			expect(await rowsInWorkspace()).toHaveLength(0)
		})

		it('gives one run row for two POSTs with the same key, one after the other', async () => {
			scriptFullRun()
			const key = crypto.randomUUID()
			const first = (await (await post(question, { key })).json()) as { id: string }
			const second = await post(question, { key })
			expect(second.status).toBe(202)
			expect(((await second.json()) as { id: string }).id).toBe(first.id)
			expect(await rowsInWorkspace()).toHaveLength(1)
			await waitForEnd(first.id)
			expect(mocks.chat).toHaveBeenCalledTimes(4)
		})

		it('gives one run row for two POSTs with the same key at the same time', async () => {
			scriptFullRun()
			const key = crypto.randomUUID()
			const [a, b] = await Promise.all([post(question, { key }), post(question, { key })])
			const ids = [((await a.json()) as { id: string }).id, ((await b.json()) as { id: string }).id]
			expect(ids[0]).toBe(ids[1])
			expect(await rowsInWorkspace()).toHaveLength(1)
			await waitForEnd(ids[0] as string)
			expect(finishedEvents()).toHaveLength(1)
		})
	})

	describe('refusals that create no row and spend nothing', () => {
		afterEach(async () => {
			expect(await rowsInWorkspace()).toHaveLength(0)
			expect(mocks.chat).not.toHaveBeenCalled()
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

		it('says comparison is not available yet', async () => {
			const res = await post({ ...question, effort: 'comparison' })
			expect(res.status).toBe(400)
			expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
				'not available yet',
			)
		})

		it('gives a plain error when the workspace has no API key, only a subscription', async () => {
			// The factory default is an enterprise workspace with no saved key: the
			// subscription route is skipped by design, so there is nothing to call.
			const bare = await insertWorkspace(db, actorId, {})
			const res = await post(question, { ws: bare.id })
			expect(res.status).toBe(400)
			const message = ((await res.json()) as { error: { message: string } }).error.message
			expect(message).toContain('Anthropic API key')
			expect(message).toContain('Claude subscription')
			const rows = await db.select().from(researchRuns).where(eq(researchRuns.workspaceId, bare.id))
			expect(rows).toHaveLength(0)
		})

		it('refuses to start on a model with no price', async () => {
			mocks.getModelPricing.mockResolvedValue(null)
			const res = await post(question)
			expect(res.status).toBe(400)
			expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
				'has no price',
			)
		})

		it('answers 402 when the plan has less than one simple run of headroom left', async () => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'or-test'
			const planned = await insertWorkspace(db, actorId, {
				enterpriseGranted: false,
				settings: { billing: { plan: 'pro', status: 'active', hard_cap_usd_cents: 20 } },
			})
			const res = await post(question, { ws: planned.id })
			expect(res.status).toBe(402)
			const rows = await db
				.select()
				.from(researchRuns)
				.where(eq(researchRuns.workspaceId, planned.id))
			expect(rows).toHaveLength(0)
		})
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
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		mocks.chat.mockImplementation(async (options: { tools?: unknown }) => {
			await gate
			return options.tools
				? textTurn(JSON.stringify({ findings: [], unread: [], gaps: [] }))
				: textTurn('## TL;DR\nNothing.')
		})

		const a = (await (await post(question)).json()) as { id: string }
		const b = (await (await post(question)).json()) as { id: string }
		const third = await post(question)
		expect(third.status).toBe(429)
		expect(await rowsInWorkspace()).toHaveLength(2)

		release()
		await waitForEnd(a.id)
		await waitForEnd(b.id)
		// A slot is free again once a run ends.
		mocks.chat.mockReset()
		scriptFullRun()
		const fourth = await post(question)
		expect(fourth.status).toBe(202)
		await waitForEnd(((await fourth.json()) as { id: string }).id)
	})
})
