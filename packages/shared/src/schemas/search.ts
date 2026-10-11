import { z } from 'zod'
import { objectTypeSchema } from './objects'

export const SEARCH_SCOPES = ['all', 'objects', 'team', 'loops'] as const
export const searchScopeSchema = z.enum(SEARCH_SCOPES)
export type SearchScope = z.infer<typeof searchScopeSchema>

export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 50
export const SEARCH_MAX_QUERY_LENGTH = 200
/** Per-scope ceiling for `counts` — the server never scans past this. */
export const SEARCH_COUNT_CAP = 100

export const searchRequestSchema = z.object({
	query: z
		.string()
		.trim()
		.min(1)
		.max(SEARCH_MAX_QUERY_LENGTH)
		.describe('Free text. Matched against titles first; see scope for what each scope covers.'),
	scope: searchScopeSchema
		.default('all')
		.describe(
			'objects = objects (title primary, content low-weight); team = workspace actors by name + your conversations by title; loops = loop objects by title/description.',
		),
	object_type: objectTypeSchema
		.optional()
		.describe('Restrict the objects scope to one object type.'),
	limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
	cursor: z
		.string()
		.min(1)
		.max(512)
		.optional()
		.describe('Opaque `next_cursor` from the previous page.'),
	include_archived: z
		.boolean()
		.default(false)
		.describe('Include objects with status "archived" (hidden by default).'),
})
export type SearchRequest = z.infer<typeof searchRequestSchema>

export const searchResultSchema = z.object({
	kind: z.enum(['object', 'actor', 'conversation']),
	id: z.string().uuid(),
	title: z
		.string()
		.describe('Human-readable label (object title, actor name, conversation title).'),
	type: z
		.string()
		.optional()
		.describe('Object type for objects, "human" | "agent" for actors. Absent for conversations.'),
	status: z.string().optional(),
	snippet: z
		.string()
		.optional()
		.describe(
			'Short content excerpt, only when the match came from content rather than the title.',
		),
	updated_at: z.string().datetime(),
	score: z.number().int().optional(),
})
export type SearchResult = z.infer<typeof searchResultSchema>

export const searchCountsSchema = z.object({
	objects: z.number().int().min(0),
	team: z.number().int().min(0),
	loops: z.number().int().min(0),
	capped: z
		.boolean()
		.describe(
			`True when any count reached ${SEARCH_COUNT_CAP}; render it as "${SEARCH_COUNT_CAP}+".`,
		),
})

export const searchResponseSchema = z.object({
	results: z.array(searchResultSchema),
	next_cursor: z.string().optional(),
	counts: searchCountsSchema
		.optional()
		.describe('Only present on the first page (no cursor in the request).'),
})
export type SearchResponse = z.infer<typeof searchResponseSchema>
