import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { researchRuns } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { ApiErrorCode, createApiError, validationFailureHook } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole, isWorkspaceMember } from '../lib/workspace-auth'
import {
	ResearchStartError,
	startResearchRun,
	toResearchRunView,
} from '../services/research-service'

type Env = {
	Variables: {
		db: Database
		actorId: string
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const NOT_ENABLED_MESSAGE = 'Deep research is not enabled for you yet.'

const startBodySchema = z.object({
	question: z
		.string()
		.min(1)
		.max(2000)
		.openapi({ example: 'What does the Danish bookkeeping act require of sole proprietors?' }),
	effort: z.enum(['simple', 'comparison', 'broad']).openapi({
		description: 'How much research to do. Only "simple" runs today.',
	}),
	context: z.string().max(2000).optional(),
	max_cost_usd: z.number().min(0.01).optional().openapi({
		description: 'Lowers the run cap in US dollars. Can never raise it above the effort default.',
	}),
})

const startResponseSchema = z.object({ id: z.string().uuid(), status: z.string() })

const runResponseSchema = z.object({
	id: z.string().uuid(),
	status: z.enum(['queued', 'running', 'done', 'capped', 'failed', 'interrupted']),
	effort: z.string(),
	report_md: z.string().nullable(),
	sources: z.array(z.any()),
	usage: z.object({
		cost_cents: z.number(),
		tokens_in: z.number(),
		tokens_out: z.number(),
		searches: z.number(),
		extracts: z.number(),
	}),
	cap: z.object({ cap_cents: z.number() }),
	warnings: z.array(z.any()),
	error: z.string().nullable(),
	created_at: z.string(),
	finished_at: z.string().nullable(),
})

const startRoute = createRoute({
	method: 'post',
	path: '/',
	// A run spends money, so a viewer may not start one.
	'x-viewer-policy': 'writer',
	tags: ['Research'],
	summary: 'Start a deep research run',
	description:
		'Creates a research run and returns at once; the run continues in the background and is read with GET /research/:id. Idempotency-Key is required: sending the same key again returns the same run instead of starting (and paying for) a second one. Behind the deep-research tester flag.',
	request: {
		headers: workspaceIdHeader.extend({ 'idempotency-key': z.string().min(1).max(200) }),
		body: { content: { 'application/json': { schema: startBodySchema } }, required: true },
	},
	responses: {
		202: {
			description: 'Run accepted',
			content: { 'application/json': { schema: startResponseSchema } },
		},
		400: {
			description: 'Invalid request or no usable credentials',
			content: { 'application/json': { schema: errorSchema } },
		},
		402: {
			description: 'Plan cap reached',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: { description: 'Not enabled', content: { 'application/json': { schema: errorSchema } } },
		429: {
			description: 'Too many runs at once',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'Search is not set up on this server',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

// Two requests with the same key that arrive together share one start. The
// shared idempotency layer only replays a request that begins after the first
// has finished. This covers one API process; a second process needs a unique
// key column on research_runs.
const startsInFlight = new Map<string, Promise<{ id: string; status: string }>>()

app.openapi(startRoute, async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	if (!isFlagEnabled(actorId, FLAGS.DEEP_RESEARCH)) {
		return c.json(createApiError(ApiErrorCode.FORBIDDEN, NOT_ENABLED_MESSAGE), 403)
	}
	const { 'x-workspace-id': workspaceId, 'idempotency-key': idempotencyKey } = c.req.valid('header')
	const body = c.req.valid('json')

	const flightKey = `${actorId}:${idempotencyKey}`
	let start = startsInFlight.get(flightKey)
	if (!start) {
		start = startResearchRun({
			db,
			actorId,
			workspaceId,
			question: body.question,
			context: body.context ?? null,
			effort: body.effort,
			maxCostUsd: body.max_cost_usd,
		})
		startsInFlight.set(flightKey, start)
		const forget = () => startsInFlight.delete(flightKey)
		start.then(forget, forget)
	}

	try {
		return c.json(await start, 202)
	} catch (err) {
		if (err instanceof ResearchStartError) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		throw err
	}
})

const getRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Research'],
	summary: 'Get a deep research run',
	description:
		'Status, report, sources, usage, cap and warnings of one run. The workspace comes from the run itself, so membership is checked here. Behind the deep-research tester flag.',
	request: { params: idParamSchema },
	responses: {
		200: { description: 'The run', content: { 'application/json': { schema: runResponseSchema } } },
		403: { description: 'Not enabled', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	if (!isFlagEnabled(actorId, FLAGS.DEEP_RESEARCH)) {
		return c.json(createApiError(ApiErrorCode.FORBIDDEN, NOT_ENABLED_MESSAGE), 403)
	}
	const { id } = c.req.valid('param')
	const [row] = await db.select().from(researchRuns).where(eq(researchRuns.id, id)).limit(1)
	// A run in a workspace the caller is not in looks the same as no run at all.
	if (!row || !(await isWorkspaceMember(db, actorId, row.workspaceId))) {
		return c.json(createApiError(ApiErrorCode.NOT_FOUND, 'Research run not found'), 404)
	}
	return c.json(toResearchRunView(row) as z.infer<typeof runResponseSchema>, 200)
})

export default app
