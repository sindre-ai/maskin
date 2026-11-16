import { OpenAPIHono, type RouteHandler, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	STATUS_GROUP_KEYS,
	parseChatSearch,
	searchQuerySchema,
	searchResponseSchema,
} from '@maskin/shared'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { loadAttentionChatIds } from '../services/chat-attention'
import { SEARCH_SOURCES, runSearch } from '../services/search'

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
	summary: 'Search chats, loops, agents, people, objects and automations together',
	description:
		'Every typed word must match (AND). Counts and facets cover the full result set; ' +
		'`results` is capped at `limit`. A source that fails is listed in `partial` and the rest still answer. ' +
		"Chats are limited to the caller's own conversations. `participants` (actor ids) keeps only chats " +
		'every listed person or agent is in, and the other sources then return nothing. ' +
		'With `operators` only chats are searched, and agent:, from:, with:, team:, is: (unread, needs, ' +
		'working, later, archived), "quoted phrases" and -words are read out of `q` as filters.',
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

	if (query.operators) {
		const parsed = parseChatSearch(query.q)
		const attention = await loadAttentionChatIds(db, {
			workspaceId,
			callerId,
			needs: parsed.is.includes('needs'),
			working: parsed.is.includes('working'),
		})
		// is:archived has to see archived chats, which a search hides unless its statuses let them in.
		const statuses =
			parsed.is.includes('archived') && !query.statuses?.includes('archived')
				? [...(query.statuses?.length ? query.statuses : STATUS_GROUP_KEYS), 'archived' as const]
				: query.statuses
		const response = await runSearch(
			db,
			{
				workspaceId,
				callerId,
				chatFilter: {
					agent: parsed.agent,
					from: parsed.from,
					with: parsed.with,
					team: parsed.team,
					is: parsed.is,
					phrases: parsed.phrases,
					exclude: parsed.exclude,
					needsIds: attention.needs,
					workingIds: attention.working,
				},
			},
			{ ...query, q: parsed.text, statuses },
			SEARCH_SOURCES.filter((source) => source.key === 'chats'),
		)
		return c.json(response, 200)
	}

	const response = await runSearch(db, { workspaceId, callerId }, query)
	return c.json(response, 200)
}) as RouteHandler<typeof searchRoute, Env>)

export default app
