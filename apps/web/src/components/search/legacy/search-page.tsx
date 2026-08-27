// PRE-V2 SEARCH VIEW — governed by the `new-design` feature flag.
//
// The cross-entity search page exactly as it shipped before the v2 rewrite. The
// route (`routes/_authed/$workspaceId/search.tsx`) renders it whenever
// `new-design` is off; the v2 page renders when it is on. This whole directory
// dies with the flag — see `.claude/rules/feature-flags.md` ("Retiring a flag").
//
// Note: the route's `validateSearch` and `useWorkspaceSearch` are shared by both
// branches. Neither is a visual concern, so neither is forked — this page simply
// ignores the `isError`/`isPartial` fields the v2 page surfaces.

import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { SearchRowIcon, SearchRowTitle } from '@/components/shared/search-row'
import { Input } from '@/components/ui/input'
import { useObjects } from '@/hooks/use-objects'
import {
	SEARCH_GROUPS,
	SEARCH_GROUP_LABEL,
	type SearchRow,
	useWorkspaceSearch,
} from '@/hooks/use-workspace-search'
import { type TaxonomyEntityType, trackSearchResultOpened } from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { highlightText } from '@/lib/search-highlight'
import {
	getRecentObjectIds,
	getRecentSearches,
	pushRecentObject,
	pushRecentSearch,
} from '@/lib/search-recents'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

const COMMIT_DEBOUNCE_MS = 300

function ResultRow({
	row,
	query,
	onOpen,
}: {
	row: SearchRow
	query: string
	onOpen: (row: SearchRow) => void
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen(row)}
			className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-muted"
		>
			<SearchRowIcon
				id={row.id}
				title={row.title}
				group={row.group}
				object={row.object}
				className="mt-0.5"
				fallback={
					<span className="mt-0.5 size-[22px] shrink-0 rounded-md bg-muted" aria-hidden="true" />
				}
			/>
			<span className="min-w-0 flex-1">
				<SearchRowTitle
					title={row.title}
					sub={row.sub}
					query={query}
					className="block font-medium"
				/>
				{row.snippet && (
					<span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
						{highlightText(row.snippet, query)}
					</span>
				)}
			</span>
		</button>
	)
}

/**
 * The cross-entity search view (mockup 2526–2545) — the "Search everything"
 * destination from both the command palette and the top nav's workspace
 * search field. Renders the same `useWorkspaceSearch` index those surfaces
 * rank with, grouped by entity type, so results never disagree between them.
 */
export function LegacySearchPage() {
	const { workspaceId } = useWorkspace()
	// The shared `validateSearch` makes `q` optional (v2 distinguishes "absent"
	// from "empty"); this page only ever wanted the empty-string default.
	const { q = '' } = useSearch({ from: '/_authed/$workspaceId/search' })
	const navigate = useNavigate()
	const [query, setQuery] = useState(q)

	// URL is the source of truth; typing commits into it after a short debounce
	// so every keystroke doesn't grow browser history or thrash `useSearch()`
	// consumers. `replace: true` keeps back-navigation at the page that linked
	// here, not at every intermediate keystroke.
	useEffect(() => {
		const timer = setTimeout(() => {
			if (query.trim() === q.trim()) return
			navigate({
				to: '/$workspaceId/search',
				params: { workspaceId },
				search: { q: query },
				replace: true,
			})
		}, COMMIT_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [query, q, navigate, workspaceId])

	// Stay in sync when `q` changes from outside this component (e.g. the
	// command palette's "Search everything" hands off with `q` already set).
	useEffect(() => {
		setQuery(q)
	}, [q])

	const trimmedQuery = q.trim()
	useEffect(() => {
		if (trimmedQuery) pushRecentSearch(workspaceId, trimmedQuery)
	}, [trimmedQuery, workspaceId])

	const { data: objects } = useObjects(workspaceId)
	const { rows, countsByGroup, total, isPending } = useWorkspaceSearch(workspaceId, { q })

	const recentSearches = useMemo(
		() => (trimmedQuery ? [] : getRecentSearches(workspaceId)),
		[trimmedQuery, workspaceId],
	)
	const recentObjects = useMemo(() => {
		if (trimmedQuery) return []
		const byId = new Map((objects ?? []).map((object) => [object.id, object]))
		return getRecentObjectIds(workspaceId)
			.map((id) => byId.get(id))
			.filter((object): object is ObjectResponse => Boolean(object))
	}, [trimmedQuery, workspaceId, objects])

	const openRow = (row: SearchRow) => {
		if (row.object) {
			trackSearchResultOpened({
				entity_id: row.object.id,
				entity_type: row.object.type as TaxonomyEntityType,
				surface: 'search_view',
			})
			pushRecentObject(workspaceId, row.object.id)
		}
		navigate({ to: row.to, params: row.params })
	}

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
			<div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 focus-within:border-border-hover">
				<Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search chats, loops, agents, objects…"
					aria-label="Search the workspace"
					className="h-auto border-0 bg-transparent p-0 text-[13.5px] shadow-none focus-visible:ring-0"
					autoFocus
				/>
			</div>

			{!trimmedQuery ? (
				recentSearches.length === 0 && recentObjects.length === 0 ? (
					<EmptyState title="Search across chats, loops, agents, objects and automations" />
				) : (
					<div className="flex flex-col gap-5">
						{recentSearches.length > 0 && (
							<div>
								<div className="eyebrow pb-2">Recent searches</div>
								<div className="flex flex-wrap gap-1.5">
									{recentSearches.map((recent) => (
										<button
											key={recent}
											type="button"
											onClick={() => setQuery(recent)}
											className="rounded-full border border-border bg-card px-2.5 py-1 text-[12px] text-foreground transition-colors duration-150 hover:border-border-hover"
										>
											{recent}
										</button>
									))}
								</div>
							</div>
						)}
						{recentObjects.length > 0 && (
							<div>
								<div className="eyebrow pb-2">Recently opened</div>
								<div className="flex flex-col divide-y divide-border rounded-lg border border-border">
									{recentObjects.map((object) => (
										<ResultRow
											key={object.id}
											query=""
											onOpen={openRow}
											row={{
												id: object.id,
												group: 'objects',
												kind: object.type.toUpperCase(),
												title: object.title ?? 'Untitled',
												sub: '',
												snippet: '',
												to: '/$workspaceId/objects/$objectId',
												params: { workspaceId, objectId: object.id },
												object,
											}}
										/>
									))}
								</div>
							</div>
						)}
					</div>
				)
			) : isPending ? (
				<ListSkeleton rows={6} />
			) : total === 0 ? (
				<EmptyState
					title={`No matches for "${trimmedQuery}"`}
					description="Try a different search term."
				/>
			) : (
				<div className="flex flex-col gap-5">
					{SEARCH_GROUPS.filter((group) => countsByGroup[group] > 0).map((group) => (
						<div key={group}>
							<div className="eyebrow pb-2">
								{SEARCH_GROUP_LABEL[group]} · {countsByGroup[group]}
							</div>
							<div className="flex flex-col divide-y divide-border rounded-lg border border-border">
								{rows
									.filter((row) => row.group === group)
									.map((row) => (
										<ResultRow
											key={`${row.group}-${row.id}`}
											row={row}
											query={trimmedQuery}
											onOpen={openRow}
										/>
									))}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
