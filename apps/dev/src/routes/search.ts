import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	objects,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	SEARCH_COUNT_CAP,
	type SearchResponse,
	type SearchResult,
	searchRequestSchema,
	searchResponseSchema,
} from '@maskin/shared'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	type RankedRow,
	type SearchCursor,
	type SearchTerms,
	buildCursorCondition,
	buildMatchCondition,
	buildScoreExpr,
	buildSearchTerms,
	buildUpdatedMsExpr,
	compareRanked,
	decodeSearchCursor,
	encodeSearchCursor,
	toSnippet,
} from '../lib/search/ranking'
import { buildObjectListConditions } from './objects'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

interface Candidate extends RankedRow {
	kind: SearchResult['kind']
	title: string
	type?: string
	status?: string
	/** First chars of content, only fetched for objects/loops. */
	head?: string
}

/** One searchable source: how to page through it and how to cap-count it (ids only, LIMIT = cap). */
interface Source {
	scope: 'objects' | 'team' | 'loops'
	page: (limit: number, cursor: SearchCursor | null) => Promise<Candidate[]>
	count: () => Promise<number>
}

const HEAD_CHARS = 400

function objectSource(
	db: Database,
	workspaceId: string,
	terms: SearchTerms,
	scope: 'objects' | 'loops',
	opts: { objectType?: string; includeArchived: boolean },
): Source {
	const title = sql`${objects.title}`
	const content = sql`${objects.content}`
	const score = buildScoreExpr(terms, title, content)
	const ms = buildUpdatedMsExpr(objects.updatedAt)

	// Reuse the legacy list/search filter builder for type + archived handling.
	const { conditions: filter } = buildObjectListConditions({
		type: scope === 'loops' ? 'loop' : opts.objectType,
		include_archived: opts.includeArchived,
	})
	const base = [
		eq(objects.workspaceId, workspaceId),
		...filter,
		// The objects scope never returns loops unless explicitly asked for; they
		// belong to the loops scope so `all` has no duplicates.
		...(scope === 'objects' && !opts.objectType ? [ne(objects.type, 'loop')] : []),
		buildMatchCondition(terms, title, content),
	]

	return {
		scope,
		count: async () => {
			const rows = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(...base))
				.limit(SEARCH_COUNT_CAP)
			return rows.length
		},
		page: async (limit, cursor) => {
			const where = cursor
				? and(...base, buildCursorCondition(cursor, score, ms, objects.id))
				: and(...base)
			const rows = await db
				.select({
					id: objects.id,
					title: objects.title,
					type: objects.type,
					status: objects.status,
					score: sql<number>`${score}`.mapWith(Number),
					ms: sql<number>`${ms}`.mapWith(Number),
					head: sql<string>`left(coalesce(${objects.content}, ''), ${HEAD_CHARS})`,
				})
				.from(objects)
				.where(where)
				.orderBy(sql`${score} desc`, sql`${ms} desc`, sql`${objects.id} asc`)
				.limit(limit)
			return rows.map((r) => ({
				kind: 'object' as const,
				id: r.id,
				title: r.title ?? '',
				type: r.type,
				status: r.status,
				score: r.score,
				ms: r.ms,
				head: r.head,
			}))
		},
	}
}

function actorSource(db: Database, workspaceId: string, terms: SearchTerms): Source {
	const title = sql`${actors.name}`
	const score = buildScoreExpr(terms, title)
	const ms = buildUpdatedMsExpr(sql`coalesce(${actors.updatedAt}, ${actors.createdAt})`)
	const base = [eq(workspaceMembers.workspaceId, workspaceId), buildMatchCondition(terms, title)]
	return {
		scope: 'team',
		count: async () => {
			const rows = await db
				.select({ id: actors.id })
				.from(workspaceMembers)
				.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
				.where(and(...base))
				.limit(SEARCH_COUNT_CAP)
			return rows.length
		},
		page: async (limit, cursor) => {
			const where = cursor
				? and(...base, buildCursorCondition(cursor, score, ms, actors.id))
				: and(...base)
			const rows = await db
				.select({
					id: actors.id,
					title: actors.name,
					type: actors.type,
					score: sql<number>`${score}`.mapWith(Number),
					ms: sql<number>`${ms}`.mapWith(Number),
				})
				.from(workspaceMembers)
				.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
				.where(where)
				.orderBy(sql`${score} desc`, sql`${ms} desc`, sql`${actors.id} asc`)
				.limit(limit)
			return rows.map((r) => ({
				kind: 'actor' as const,
				id: r.id,
				title: r.title,
				type: r.type,
				score: r.score,
				ms: r.ms,
			}))
		},
	}
}

/** Conversations are private to their participants — only the caller's own are searched, by title only. */
function conversationSource(
	db: Database,
	workspaceId: string,
	callerId: string,
	terms: SearchTerms,
): Source {
	const title = sql`${conversations.title}`
	const score = buildScoreExpr(terms, title)
	const ms = buildUpdatedMsExpr(conversations.lastMessageAt)
	const base = [
		eq(conversations.workspaceId, workspaceId),
		eq(conversationParticipants.actorId, callerId),
		isNull(conversationParticipants.leftAt),
		buildMatchCondition(terms, title),
	]
	const join = eq(conversationParticipants.conversationId, conversations.id)
	return {
		scope: 'team',
		count: async () => {
			const rows = await db
				.select({ id: conversations.id })
				.from(conversations)
				.innerJoin(conversationParticipants, join)
				.where(and(...base))
				.limit(SEARCH_COUNT_CAP)
			return rows.length
		},
		page: async (limit, cursor) => {
			const where = cursor
				? and(...base, buildCursorCondition(cursor, score, ms, conversations.id))
				: and(...base)
			const rows = await db
				.select({
					id: conversations.id,
					title: conversations.title,
					score: sql<number>`${score}`.mapWith(Number),
					ms: sql<number>`${ms}`.mapWith(Number),
				})
				.from(conversations)
				.innerJoin(conversationParticipants, join)
				.where(where)
				.orderBy(sql`${score} desc`, sql`${ms} desc`, sql`${conversations.id} asc`)
				.limit(limit)
			return rows.map((r) => ({
				kind: 'conversation' as const,
				id: r.id,
				title: r.title,
				score: r.score,
				ms: r.ms,
			}))
		},
	}
}

function toResult(c: Candidate, terms: SearchTerms): SearchResult {
	const result: SearchResult = {
		kind: c.kind,
		id: c.id,
		title: c.title,
		updated_at: new Date(c.ms).toISOString(),
		score: c.score,
	}
	if (c.type) result.type = c.type
	if (c.status) result.status = c.status
	// Snippet only when the title itself did not match — the content is why this row is here.
	if (c.head) {
		const lowerTitle = c.title.toLowerCase()
		if (!terms.tokens.some((t) => lowerTitle.includes(t))) {
			const snippet = toSnippet(c.head)
			if (snippet) result.snippet = snippet
		}
	}
	return result
}

const searchRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Search'],
	summary: 'Search the workspace by title',
	description:
		'Ranked, cursor-paginated search. Titles are the primary signal; conversation message text and loop/team artefact bodies are never searched. Ranking: exact title (1000) + title prefix (400) + all tokens in title (200) + 40 per title token + all tokens present (15) + 2 per content token (objects only), then updated_at DESC, then id ASC.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: searchRequestSchema } }, required: true },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: searchResponseSchema } },
			description: 'Ranked results',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(searchRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	let cursor: SearchCursor | null = null
	if (body.cursor) {
		cursor = decodeSearchCursor(body.cursor)
		if (!cursor) {
			return c.json(createApiError('VALIDATION_ERROR', 'Invalid cursor'), 400)
		}
	}

	const terms = buildSearchTerms(body.query)
	const wantObjects = body.scope === 'all' || body.scope === 'objects'
	const wantLoops = body.scope === 'all' || body.scope === 'loops'
	const wantTeam = body.scope === 'all' || body.scope === 'team'
	const objectOpts = { objectType: body.object_type, includeArchived: body.include_archived }

	const sources: Source[] = []
	// `all` + object_type=loop would return each loop twice (objects and loops sources).
	if (wantObjects && !(body.scope === 'all' && body.object_type === 'loop')) {
		sources.push(objectSource(db, workspaceId, terms, 'objects', objectOpts))
	}
	if (wantLoops) sources.push(objectSource(db, workspaceId, terms, 'loops', objectOpts))
	if (wantTeam) {
		sources.push(actorSource(db, workspaceId, terms))
		sources.push(conversationSource(db, workspaceId, actorId, terms))
	}

	// Each source returns its own top `limit + 1` after the cursor; merging them
	// by the shared total order yields the global page without a UNION.
	const pages = await Promise.all(sources.map((s) => s.page(body.limit + 1, cursor)))
	const merged = pages.flat().sort(compareRanked)
	const pageRows = merged.slice(0, body.limit)
	const last = pageRows[pageRows.length - 1]

	const response: SearchResponse = { results: pageRows.map((r) => toResult(r, terms)) }
	if (merged.length > body.limit && last) {
		response.next_cursor = encodeSearchCursor({ s: last.score, u: last.ms, i: last.id })
	}

	// Counts only on the first page: the app shows "42 results" once, not per page.
	if (!cursor) {
		const countSources: Source[] = [
			objectSource(db, workspaceId, terms, 'objects', objectOpts),
			objectSource(db, workspaceId, terms, 'loops', objectOpts),
			actorSource(db, workspaceId, terms),
			conversationSource(db, workspaceId, actorId, terms),
		]
		const [objectsN, loopsN, actorsN, convsN] = await Promise.all(
			countSources.map((s) => s.count()),
		)
		const teamN = (actorsN ?? 0) + (convsN ?? 0)
		const counts = {
			objects: Math.min(objectsN ?? 0, SEARCH_COUNT_CAP),
			loops: Math.min(loopsN ?? 0, SEARCH_COUNT_CAP),
			team: Math.min(teamN, SEARCH_COUNT_CAP),
		}
		response.counts = {
			...counts,
			capped: Math.max(objectsN ?? 0, loopsN ?? 0, teamN) >= SEARCH_COUNT_CAP,
		}
	}

	return c.json(response, 200)
})

export default app
