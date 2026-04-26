import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { headlineResponseSchema } from '@maskin/shared'
import { createApiError } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'
import { buildHeadline } from '../services/dashboard-headline'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const headlineParamsSchema = z.object({
	id: z.string().uuid(),
})

// GET /api/workspaces/:id/headline
const headlineRoute = createRoute({
	method: 'get',
	path: '/{id}/headline',
	tags: ['workspaces'],
	summary: 'Get the workspace dashboard headline (LLM with rule-based fallback)',
	request: {
		params: headlineParamsSchema,
	},
	responses: {
		200: {
			description: 'One-sentence narrative summary of the workspace state',
			content: { 'application/json': { schema: headlineResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(headlineRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const headline = await buildHeadline(db, id)
	if (!headline) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	return c.json(headline)
}) as RouteHandler<typeof headlineRoute, Env>)

export default app
