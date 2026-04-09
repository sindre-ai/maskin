import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { errorSchema } from '../lib/openapi-schemas'
import { getPublicMetrics, getUsageMetrics } from '../services/metrics'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const objectTypeMetricSchema = z.object({
	type: z.string(),
	count: z.number(),
})

const providerMetricSchema = z.object({
	provider: z.string(),
	count: z.number(),
})

const usageMetricsSchema = z.object({
	workspaces: z.object({
		total: z.number(),
		daily: z.number(),
		weekly: z.number(),
	}),
	objects: z.object({
		total: z.number(),
		byType: z.array(objectTypeMetricSchema),
		daily: z.number(),
		weekly: z.number(),
	}),
	agents: z.object({
		configured: z.number(),
		sessionsRun: z.number(),
		sessionsDaily: z.number(),
		sessionsWeekly: z.number(),
	}),
	agentHours: z.object({
		totalSeconds: z.number(),
		weeklySeconds: z.number(),
	}),
	integrations: z.object({
		connected: z.number(),
		byProvider: z.array(providerMetricSchema),
	}),
})

const publicMetricsSchema = z.object({
	workspacesCreated: z.number(),
	agentSessionsRun: z.number(),
	agentHoursThisWeek: z.number(),
	objectsCreated: z.number(),
})

const app = new OpenAPIHono<Env>()

// GET /api/metrics — full usage metrics (authenticated)
const getMetricsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['metrics'],
	summary: 'Get aggregate usage metrics',
	responses: {
		200: {
			description: 'Usage metrics',
			content: { 'application/json': { schema: usageMetricsSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getMetricsRoute, async (c) => {
	const db = c.get('db')
	const metrics = await getUsageMetrics(db)
	return c.json(metrics)
})

// GET /api/metrics/public — lightweight public counters (no auth)
const getPublicMetricsRoute = createRoute({
	method: 'get',
	path: '/public',
	tags: ['metrics'],
	summary: 'Get public usage counters for landing page',
	responses: {
		200: {
			description: 'Public metrics',
			content: { 'application/json': { schema: publicMetricsSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getPublicMetricsRoute, async (c) => {
	const db = c.get('db')
	const metrics = await getPublicMetrics(db)
	return c.json(metrics)
})

export default app
