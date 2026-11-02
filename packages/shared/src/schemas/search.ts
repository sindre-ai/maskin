import { z } from 'zod'
import { STATUS_GROUP_KEYS } from '../search/status-groups'
import { objectTypeSchema } from './objects'

/** Cap on rows returned. The launcher passes a smaller limit. */
export const SEARCH_MAX_LIMIT = 150
export const SEARCH_QUERY_MAX_LENGTH = 200
export const SEARCH_MAX_TYPES = 30
export const SEARCH_MAX_PARTICIPANTS = 5

export const SEARCH_SORTS = ['rel', 'recent', 'az'] as const

/** The six places search reads from. Also the order of groups under Relevance sort. */
export const SEARCH_SOURCE_GROUPS = [
	'chats',
	'loops',
	'agents',
	'people',
	'objects',
	'automations',
] as const

export const statusGroupKeySchema = z.enum(STATUS_GROUP_KEYS)

/** A comma-separated list in a query string, read as an array. Empty entries are dropped. */
const csvParam = <T extends z.ZodTypeAny>(item: T, max: number) =>
	z.preprocess(
		(value) =>
			typeof value === 'string'
				? value
						.split(',')
						.map((part) => part.trim())
						.filter((part) => part.length > 0)
				: value,
		z.array(item).max(max),
	)

/**
 * GET /api/search query string. Types are any object type key plus chat, agent,
 * person and automation; an unknown key is accepted and matches nothing. Statuses are
 * the five group keys, and an unknown group is a 400. There is no owner filter.
 * Participants are actor ids (people or agents): only chats the caller is in AND
 * every listed actor is in can match, so the other four sources return nothing.
 */
export const searchQuerySchema = z.object({
	q: z.string().trim().max(SEARCH_QUERY_MAX_LENGTH).optional(),
	types: csvParam(objectTypeSchema, SEARCH_MAX_TYPES).optional(),
	statuses: csvParam(statusGroupKeySchema, STATUS_GROUP_KEYS.length).optional(),
	participants: csvParam(z.string().uuid(), SEARCH_MAX_PARTICIPANTS).optional(),
	/** Half-open: rows satisfy `updated_at > updated_after`. Same meaning as the objects routes. */
	updated_after: z.string().datetime({ offset: true }).optional(),
	sort: z.enum(SEARCH_SORTS).default('rel'),
	limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_MAX_LIMIT),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>
export type SearchSort = (typeof SEARCH_SORTS)[number]
export type SearchSourceGroup = (typeof SEARCH_SOURCE_GROUPS)[number]

export const searchResultRowSchema = z.object({
	id: z.string().uuid(),
	group: z.enum(SEARCH_SOURCE_GROUPS),
	/** chat, agent, person, automation, or the object type key (loop included). */
	type: z.string(),
	title: z.string(),
	sub: z.string().nullable(),
	/** Cut to 160 characters on the server; never the full body. */
	snippet: z.string().max(160).nullable(),
	/** The raw status (or the value derived for chats, agents and automations; a person is always member). */
	status: z.string(),
	statusGroup: statusGroupKeySchema,
	/** ISO timestamp of the last update, null when the source has none. */
	updatedAt: z.string().datetime({ offset: true }).nullable(),
})

export type SearchResultRow = z.infer<typeof searchResultRowSchema>

const count = z.number().int().nonnegative()

export const searchResponseSchema = z.object({
	results: z.array(searchResultRowSchema).max(SEARCH_MAX_LIMIT),
	/** Matches after all filters, before the cap. */
	total: count,
	/** True when total is larger than the rows returned. */
	capped: z.boolean(),
	facets: z.object({
		/** Per type key, text match only. Includes a key for every searchable type, zeros too. */
		types: z.record(z.string(), count),
		/** Per status group, text match plus the selected types. */
		statuses: z.object({
			needs_you: count,
			in_progress: count,
			new: count,
			done: count,
			archived: count,
		}),
	}),
	/** What the empty state offers: totals with the filters (or just the statuses) dropped. */
	relaxed: z.object({
		withoutFilters: count,
		withoutStatuses: count,
	}),
	/** Sources that failed. Their rows and counts are left out; the others still answer. */
	partial: z.array(z.enum(SEARCH_SOURCE_GROUPS)),
})

export type SearchResponse = z.infer<typeof searchResponseSchema>
