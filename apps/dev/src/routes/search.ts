import { OpenAPIHono, type RouteHandler, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	STATUS_GROUP_KEYS,
	parseChatSearch,
	searchOpenBodySchema,
	searchOpensResponseSchema,
	searchQuerySchema,
	searchResponseSchema,
} from '@maskin/shared'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { loadAttentionChatIds } from '../services/chat-attention'
import { SEARCH_SOURCES, runSearch } from '../services/search'
import { listSearchOpenBonuses, recordSearchOpen } from '../services/search-opens'

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

const openRoute = createRoute({
	method: 'post',
	path: '/opens',
	tags: ['Search'],
	summary: 'Record that the caller opened a search result',
	description:
		'Call it when a person opens a result from a search (the launcher, the search page or the ' +
		"phone search tab), never for a page view outside search. Opens count towards the caller's " +
		'own ranking only: a result they opened often and lately ranks higher for a typed query, ' +
		'after the match tier. The count halves every 14 days.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: searchOpenBodySchema } } },
	},
	responses: {
		204: { description: 'Recorded' },
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid body',
		},
	},
})

app.openapi(openRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { entity_id: entityId } = c.req.valid('json')
	await recordSearchOpen(db, { workspaceId, actorId, entityId })
	return c.body(null, 204)
}) as RouteHandler<typeof openRoute, Env>)

const listOpensRoute = createRoute({
	method: 'get',
	path: '/opens',
	tags: ['Search'],
	summary: 'The ranking bonus of the results the caller opened from search',
	description:
		"For a client that ranks search results on the device: the caller's own opened results with a " +
		'bonus above zero, best first (at most 200). Add `bonus` after the match tier and before ' +
		"unread. Only the caller's own history is read.",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			content: { 'application/json': { schema: searchOpensResponseSchema } },
			description: 'Bonuses, decayed to now',
		},
	},
})

app.openapi(listOpensRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const opens = await listSearchOpenBonuses(db, { workspaceId, actorId })
	return c.json({ opens }, 200)
}) as RouteHandler<typeof listOpensRoute, Env>)

export default app
