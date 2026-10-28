import { OpenAPIHono, type RouteHandler, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { searchQuerySchema, searchResponseSchema } from '@maskin/shared'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { runSearch } from '../services/search'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const searchRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Search'],
	summary: 'Search chats, loops, agents, objects and automations together',
	description:
		'Every typed word must match (AND). Counts and facets cover the full result set; ' +
		'`results` is capped at `limit`. A source that fails is listed in `partial` and the rest still answer. ' +
		"Chats are limited to the caller's own conversations.",
	request: { headers: workspaceIdHeader, query: searchQuerySchema },
	responses: {
		200: {
			content: { 'application/json': { schema: searchResponseSchema } },
			description: 'Results with true counts',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid query',
		},
	},
})

app.openapi(searchRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const response = await runSearch(db, { workspaceId, callerId }, query)
	return c.json(response, 200)
}) as RouteHandler<typeof searchRoute, Env>)

export default app
