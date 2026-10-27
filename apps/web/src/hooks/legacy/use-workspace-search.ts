// LEGACY: used only while the `search-v2` flag is off. This directory is deleted with the
// flag (see routes/_authed/$workspaceId.tsx and routes/_authed/$workspaceId/search.tsx).
// Do not add features here.

import { useActors } from '@/hooks/use-actors'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useLoops } from '@/hooks/use-loops'
import { useSearchObjects } from '@/hooks/use-objects'
import { useTriggers } from '@/hooks/use-triggers'
import type { ObjectResponse } from '@/lib/api'
import { statusLabel } from '@/lib/constants'
import { matches, rankTitleMatchesFirst } from '@/lib/palette/ranking'
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

// Matching and ranking live in lib/palette so the launcher and this hook share one
// implementation; re-exported here for existing callers.
export { matches, rankTitleMatchesFirst } from '@/lib/palette/ranking'

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
