import { useActors } from '@/hooks/use-actors'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useLoops } from '@/hooks/use-loops'
import { useSearchObjects } from '@/hooks/use-objects'
import { useTriggers } from '@/hooks/use-triggers'
import type { ObjectResponse } from '@/lib/api'
import { statusLabel } from '@/lib/constants'
import { useMemo } from 'react'

/**
 * The cross-entity search index behind `/search` (mockup 2526–2545): one result
 * list spanning chats, loops, agents, objects and automations.
 *
 * It composes existing hooks rather than adding API surface. Objects are
 * filtered server-side by `GET /objects/search`; the other four lists have no
 * `q` parameter, so they are filtered client-side over the workspace lists the
 * app already caches. Chats are limited to the conversations hook's first page
 * (30) — a workspace with more chats than that will not surface older ones
 * until `GET /conversations` grows a `q` parameter.
 */

export const SEARCH_GROUPS = [
	'chats',
	'loops',
	'agents',
	'people',
	'objects',
	'automations',
] as const

export type SearchGroup = (typeof SEARCH_GROUPS)[number]

export const SEARCH_GROUP_LABEL: Record<SearchGroup, string> = {
	chats: 'Chats',
	loops: 'Loops',
	agents: 'Agents',
	people: 'People',
	objects: 'Objects',
	automations: 'Automations',
}

export interface SearchRow {
	id: string
	group: SearchGroup
	/** Right-aligned kind column (mockup 2545) — the object's own type for
	 *  objects, the group's singular noun otherwise. */
	kind: string
	title: string
	/** Muted " — sub" appended to the title on the same line. */
	sub: string
	snippet: string
	to: string
	params: Record<string, string>
	/** Search params for the destination, e.g. which member dialog to open. */
	search?: Record<string, string>
	/** Only set for `objects`, so the page can keep firing the analytics +
	 *  recents side effects the object rows already own. */
	object?: ObjectResponse
}

export interface WorkspaceSearchResult {
	rows: SearchRow[]
	countsByGroup: Record<SearchGroup, number>
	total: number
	/** True while a committed query has produced no object results yet — the
	 *  page shows "Searching…" instead of flashing the no-match state. */
	isPending: boolean
	/** The object search itself failed. Nothing can be shown, so the page
	 *  renders an error rather than sitting on "Searching…" forever — a failed
	 *  query never resolves, so `isPending` alone would stay true indefinitely. */
	isError: boolean
	/** One of the secondary sources (loops / agents / triggers / chats) failed
	 *  while the object search succeeded. Results are real but incomplete, so
	 *  counts would otherwise understate silently. */
	isPartial: boolean
	/** The object search and all four secondary lists have finished loading (or
	 *  failed). False while any is still pending, so a cold deep link is not read
	 *  as a zero-result search. A failed source counts as finished: it shows up as
	 *  isPartial, or as isError for the object search. */
	isSettled: boolean
}

function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
}

/** Edit distance (insert, delete, substitute, swap of neighbours); stops early once past `max`. */
function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1
	let beforePrev: number[] = []
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
	for (let i = 1; i <= a.length; i++) {
		const row = [i]
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			let best = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, beforePrev[j - 2] + 1)
			}
			row.push(best)
		}
		beforePrev = prev
		prev = row
	}
	return prev[b.length]
}

/** Typos allowed in a term. Short terms get none: one wrong letter there is a different word. */
function typoBudget(term: string): number {
	if (term.length >= 8) return 2
	return term.length >= 4 ? 1 : 0
}

/** True when `term` is a near miss of a word in `text` ("mgnus" for "Magnus"), or of the start of one. */
function fuzzyHit(term: string, text: string): boolean {
	const max = typoBudget(term)
	if (max === 0) return false
	return wordsOf(text).some(
		(word) =>
			editDistance(term, word, max) <= max ||
			(word.length > term.length && editDistance(term, word.slice(0, term.length), max) <= max),
	)
}

/**
 * True when every term of the query is found in some field, in any order and
 * not necessarily the same field ("baker anna" finds "Anna Baker"). A term of
 * four or more letters may also be a near miss of a word ("mgnus" finds "Magnus").
 */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (terms.length === 0) return true
	const haystacks = fields.map((field) => (field ?? '').toLowerCase())
	return terms.every((term) =>
		haystacks.some((haystack) => haystack.includes(term) || fuzzyHit(term, haystack)),
	)
}

/** True when any whitespace-separated term of the query appears in the title. */
export function titleMatches(query: string, title: string): boolean {
	const haystack = title.toLowerCase()
	return query
		.toLowerCase()
		.split(/\s+/)
		.some((term) => term.length > 0 && haystack.includes(term))
}

/** Share of the title (0..1) covered by the query terms found in it. */
export function titleCoverage(query: string, title: string): number {
	if (!title) return 0
	const haystack = title.toLowerCase()
	const matched = query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0 && haystack.includes(term))
		.reduce((sum, term) => sum + term.length, 0)
	return Math.min(matched / title.length, 1)
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when `term` begins a word in `title` (so "b" matches "Anna Baker", not "Anna Eve"). */
function startsAWord(term: string, title: string): boolean {
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u').test(title)
}

/**
 * How well a title matches, best first: the whole query typed at a word start
 * ("anna b" → "Anna Baker") beats every term starting a word, which beats a
 * term merely appearing somewhere, which beats a title with a typo in it,
 * which beats a content-only match.
 */
function titleTier(query: string, title: string): number {
	const lowerTitle = title.toLowerCase()
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (terms.length === 0) return 0
	if (startsAWord(terms.join(' '), lowerTitle)) return 3
	if (terms.every((term) => startsAWord(term, lowerTitle))) return 2
	if (titleMatches(query, title)) return 1
	return terms.every((term) => lowerTitle.includes(term) || fuzzyHit(term, lowerTitle)) ? 0.5 : 0
}

/**
 * Best title matches first; within a tier the largest share of the title
 * matched first, content-only matches last. Array.sort is stable, so the group
 * order (and the server's rank order) is kept among equals.
 */
export function rankTitleMatchesFirst(rows: SearchRow[], query: string): SearchRow[] {
	const scored = rows.map((row) => {
		const tier = titleTier(query, row.title)
		const phraseLength = query.trim().replace(/\s+/g, ' ').length
		const coverage =
			tier === 3
				? Math.min(phraseLength / (row.title.length || 1), 1)
				: titleCoverage(query, row.title)
		return { row, tier, coverage }
	})
	scored.sort((a, b) => b.tier - a.tier || b.coverage - a.coverage)
	return scored.map(({ row }) => row)
}

/**
 * `q` filters the local lists (chats, loops, agents, people, automations) on
 * every call, so a surface can pass the live keystroke. `serverQ` is the query
 * the `/objects/search` call runs with; a surface that debounces it passes the
 * debounced text there and gets the previous object rows back until the new
 * ones settle. Left out, it follows `q`. `enabled: false` fires no request
 * at all, for a surface that is mounted but closed.
 */
export function useWorkspaceSearch(
	workspaceId: string,
	{
		q,
		serverQ,
		type,
		status,
		enabled: queriesEnabled = true,
	}: { q: string; serverQ?: string; type?: string; status?: string; enabled?: boolean },
): WorkspaceSearchResult {
	const query = q.trim()
	const serverQuery = (serverQ ?? q).trim()
	const enabled = queriesEnabled && query.length > 0

	const {
		data: objectResults,
		isError: objectsFailed,
		isPending: objectsPending,
		isPlaceholderData: objectsStale,
	} = useSearchObjects(
		workspaceId,
		{ q: serverQuery, type, status },
		{ enabled: queriesEnabled, keepPrevious: serverQ !== undefined },
	)
	const {
		data: loops,
		isError: loopsFailed,
		isPending: loopsPending,
	} = useLoops(workspaceId, { enabled: queriesEnabled })
	const {
		data: actors,
		isError: actorsFailed,
		isPending: actorsPending,
	} = useActors(workspaceId, { enabled: queriesEnabled })
	const {
		data: triggers,
		isError: triggersFailed,
		isPending: triggersPending,
	} = useTriggers(workspaceId, { enabled: queriesEnabled })
	const {
		data: conversations,
		isError: chatsFailed,
		isPending: chatsPending,
	} = useConversationsInfinite(workspaceId, undefined, { enabled: queriesEnabled })

	// Secondary sources are consumed as `?? []` below, so a failure would drop a
	// whole group to zero and hide its chip while the header still claimed a
	// confident total. Track it so the page can say results are incomplete.
	const isPartial = loopsFailed || actorsFailed || triggersFailed || chatsFailed

	const isSettled =
		enabled &&
		serverQuery === query &&
		!objectsStale &&
		!objectsPending &&
		!loopsPending &&
		!actorsPending &&
		!triggersPending &&
		!chatsPending

	const firstChatPage = conversations?.pages?.[0]?.conversations

	return useMemo(() => {
		let rows: SearchRow[] = []
		const countsByGroup: Record<SearchGroup, number> = {
			chats: 0,
			loops: 0,
			agents: 0,
			people: 0,
			objects: 0,
			automations: 0,
		}

		if (!enabled) {
			return {
				rows,
				countsByGroup,
				total: 0,
				isPending: false,
				isError: false,
				isPartial: false,
				isSettled: false,
			}
		}

		for (const conversation of firstChatPage ?? []) {
			const participants = conversation.participants.map((p) => p.actorName).join(', ')
			if (!matches(query, conversation.title, participants, conversation.snippet)) continue
			rows.push({
				id: conversation.id,
				group: 'chats',
				kind: 'CHAT',
				title: conversation.title || 'Untitled chat',
				sub: participants,
				snippet: conversation.snippet ?? '',
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation.id },
			})
		}

		for (const loop of loops ?? []) {
			const name = loop.name ?? 'Untitled loop'
			if (!matches(query, name, loop.content, loop.entryCondition)) continue
			rows.push({
				id: loop.id,
				group: 'loops',
				kind: 'LOOP',
				title: name,
				sub: loop.status,
				snippet: loop.content ?? '',
				to: '/$workspaceId/loops/$loopId',
				params: { workspaceId, loopId: loop.id },
			})
		}

		for (const actor of actors ?? []) {
			if (actor.type !== 'agent' && actor.type !== 'human') continue
			if (!matches(query, actor.name, actor.description)) continue
			// People have no page of their own: they open their dialog on the members list.
			if (actor.type === 'human') {
				rows.push({
					id: actor.id,
					group: 'people',
					kind: 'PERSON',
					title: actor.name,
					sub: '',
					snippet: actor.description ?? '',
					to: '/$workspaceId/settings/members',
					params: { workspaceId },
					search: { member: actor.id },
				})
				continue
			}
			rows.push({
				id: actor.id,
				group: 'agents',
				kind: 'AGENT',
				title: actor.name,
				sub: '',
				snippet: actor.description ?? '',
				to: '/$workspaceId/agents/$agentId',
				params: { workspaceId, agentId: actor.id },
			})
		}

		for (const object of objectResults ?? []) {
			rows.push({
				id: object.id,
				group: 'objects',
				kind: object.type.toUpperCase(),
				title: object.title ?? 'Untitled',
				// Status rides the muted title suffix, the same slot loops and
				// automations already use, so the trailing column stays a uniform
				// kind label across every result type (mockup 2544).
				sub: statusLabel(object.status),
				snippet: object.content ?? '',
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId: object.id },
				object,
			})
		}

		for (const trigger of triggers ?? []) {
			if (!matches(query, trigger.name, trigger.actionPrompt, trigger.type)) continue
			rows.push({
				id: trigger.id,
				group: 'automations',
				kind: 'AUTOMATION',
				title: trigger.name,
				sub: trigger.type,
				snippet: trigger.actionPrompt,
				to: '/$workspaceId/triggers/$triggerId',
				params: { workspaceId, triggerId: trigger.id },
			})
		}

		rows = rankTitleMatchesFirst(rows, query)

		for (const row of rows) countsByGroup[row.group] += 1

		return {
			rows,
			countsByGroup,
			total: rows.length,
			isPending: objectResults === undefined && !objectsFailed,
			isError: objectsFailed,
			isPartial,
			isSettled,
		}
	}, [
		enabled,
		query,
		workspaceId,
		firstChatPage,
		loops,
		actors,
		objectResults,
		triggers,
		objectsFailed,
		isPartial,
		isSettled,
	])
}
