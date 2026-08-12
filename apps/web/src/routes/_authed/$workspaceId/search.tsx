import { type FilterTabItem, FilterTabs } from '@/components/shared/filter-tabs'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { useObjects, useSearchObjects } from '@/hooks/use-objects'
import {
	type TaxonomyEntityType,
	trackCommandPaletteOpened,
	trackSearchResultOpened,
} from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { statusLabel, typeLabel } from '@/lib/constants'
import { highlightText } from '@/lib/search-highlight'
import {
	getRecentObjectIds,
	getRecentSearches,
	pushRecentObject,
	pushRecentSearch,
} from '@/lib/search-recents'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const SEARCH_DEBOUNCE_MS = 300

// Workflow statuses the /search view ships with, mirroring the Designer mockup's
// chip set. Custom statuses configured in workspace settings (per object type)
// are unioned over this fallback so the filter always reflects the workspace.
const DEFAULT_STATUS_FILTERS = ['active', 'in_progress', 'todo', 'define', 'in_review', 'done']

const TYPE_FILTERS = ['insight', 'bet', 'task'] as const

interface SearchParams {
	q?: string
	type?: string
	status?: string
}

export const Route = createFileRoute('/_authed/$workspaceId/search')({
	component: SearchView,
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		q: typeof search.q === 'string' ? search.q : undefined,
		type: typeof search.type === 'string' ? search.type : undefined,
		status: typeof search.status === 'string' ? search.status : undefined,
	}),
})

function SearchView() {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const router = useRouter()
	const search = useSearch({ from: '/_authed/$workspaceId/search' })
	const inputRef = useRef<HTMLInputElement>(null)

	// Input is synced from URL `q` so deep links, the palette's See-all footer,
	// and back/forward all restore the box. The URL is the source of truth;
	// local state only smooths typing before the debounce lands.
	const [input, setInput] = useState(search.q ?? '')
	useEffect(() => {
		setInput(search.q ?? '')
	}, [search.q])

	const searchParamsRef = useRef(search)
	useEffect(() => {
		searchParamsRef.current = search
	}, [search])

	// One `command_palette_opened` on mount — the /search half of the funnel
	// denominator, mirroring the palette's fire-on-open. The palette's See-all
	// footer navigates here, so footer arrivals produce their own open event.
	useEffect(() => {
		trackCommandPaletteOpened({ surface: 'search_view' })
	}, [])

	// Search is a keyboard-first surface; focus the box on entry so a typed
	// query lands immediately (a11y rule prefers programmatic focus over the
	// autoFocus attribute).
	useEffect(() => {
		inputRef.current?.focus()
	}, [])

	const updateSearch = useCallback(
		(updates: Partial<SearchParams>) => {
			const next: Record<string, unknown> = { ...searchParamsRef.current, ...updates }
			for (const key of Object.keys(next)) {
				if (next[key] === undefined || next[key] === '') delete next[key]
			}
			navigate({
				to: '/$workspaceId/search',
				params: { workspaceId },
				search: next as SearchParams,
				replace: true,
			})
		},
		[navigate, workspaceId],
	)

	// Debounced URL commit — the server search (shared engine) keys off URL `q`,
	// so typing never fires a request per keystroke.
	useEffect(() => {
		const trimmed = input.trim()
		if (trimmed === (searchParamsRef.current.q ?? '')) return
		const t = setTimeout(() => updateSearch({ q: trimmed || undefined }), SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(t)
	}, [input, updateSearch])

	const { data: results, isFetching } = useSearchObjects(workspaceId, {
		q: search.q ?? '',
		type: search.type,
		status: search.status,
	})

	// Recents (empty-query state) resolved against the objects list cache.
	const { data: objects = [] } = useObjects(workspaceId)
	const objectById = useMemo(() => {
		const map = new Map<string, ObjectResponse>()
		for (const obj of objects) map.set(obj.id, obj)
		return map
	}, [objects])
	const recentSearches = useMemo(() => getRecentSearches(workspaceId).slice(0, 4), [workspaceId])
	const recentObjects = useMemo(
		() =>
			getRecentObjectIds(workspaceId)
				.map((id) => objectById.get(id))
				.filter(Boolean) as ObjectResponse[],
		[objectById, workspaceId],
	)

	// Type chips: the mockup's three core types. Status chips: workspace settings
	// statuses unioned across object types, falling back to the mockup's set.
	const typeTabs = useMemo<Array<FilterTabItem<string | undefined>>>(
		() => [
			{ label: 'All types', value: undefined },
			...TYPE_FILTERS.map((type) => ({ label: typeLabel(type), value: type })),
		],
		[],
	)
	const statusTabs = useMemo<Array<FilterTabItem<string | undefined>>>(() => {
		const settings = workspace.settings as { statuses?: Record<string, string[]> } | undefined
		const configured = settings?.statuses
		const union: string[] = []
		if (configured) {
			for (const list of Object.values(configured)) {
				for (const status of list) {
					if (!union.includes(status)) union.push(status)
				}
			}
		}
		const statuses = union.length > 0 ? union : DEFAULT_STATUS_FILTERS
		return [
			{ label: 'Any status', value: undefined },
			...statuses.map((status) => ({ label: statusLabel(status), value: status })),
		]
	}, [workspace.settings])

	const openObject = useCallback(
		(obj: ObjectResponse) => {
			trackSearchResultOpened({
				entity_id: obj.id,
				entity_type: obj.type as TaxonomyEntityType,
				surface: 'search_view',
			})
			pushRecentObject(workspaceId, obj.id)
			navigate({ to: '/$workspaceId/objects/$objectId', params: { workspaceId, objectId: obj.id } })
		},
		[navigate, workspaceId],
	)

	const runRecentSearch = useCallback(
		(query: string) => {
			pushRecentSearch(workspaceId, query)
			setInput(query)
			updateSearch({ q: query })
		},
		[updateSearch, workspaceId],
	)

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key !== 'Escape') return
			if (input.trim()) {
				setInput('')
			} else {
				// Second Esc (or Esc on an empty box) steps back to wherever the
				// search view was opened from.
				router.history.back()
			}
		},
		[input, router],
	)

	const query = (search.q ?? '').trim()
	const hasQuery = query.length > 0
	// Show "Searching…" only while a query is committed and no results have
	// arrived yet. Folding isFetching out of searchRequested as originally
	// written made the loading branch dead and flashed "No results" on first search.
	const searchRequested = hasQuery && !results

	const typeFilterLabel = search.type ? typeLabel(search.type) : undefined
	const statusFilterLabel = search.status ? statusLabel(search.status) : undefined

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{/* Header — back, query box, Esc hint; mirrors the mockup's sv-header */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-popover px-1 py-1 md:px-2">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Back"
					onClick={() => router.history.back()}
					className="h-8 w-8 shrink-0"
				>
					<ArrowLeft size={16} />
				</Button>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<input
						ref={inputRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Search everything…"
						aria-label="Search"
						className="h-9 w-full min-w-0 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
					<kbd className="hidden shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex">
						Esc
					</kbd>
				</div>
			</div>

			{/* Filter bar — Type + Status chips; scrolls as one row on mobile */}
			<div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-popover px-2 py-1.5 [scrollbar-width:none] max-sm:-mx-4 max-sm:px-4 [&::-webkit-scrollbar]:hidden">
				<span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
					Type
				</span>
				<FilterTabs
					tabs={typeTabs}
					value={search.type}
					onChange={(type) => updateSearch({ type })}
					aria-label="Filter by type"
					className="shrink-0 max-sm:[&>button]:min-h-11"
				/>
				<span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
					Status
				</span>
				<FilterTabs
					tabs={statusTabs}
					value={search.status}
					onChange={(status) => updateSearch({ status })}
					aria-label="Filter by status"
					className="shrink-0 max-sm:[&>button]:min-h-11"
				/>
			</div>

			{/* Content */}
			<div className="mx-auto w-full max-w-[900px] flex-1 overflow-y-auto">
				<div className="px-2 pb-6 pt-4 md:px-4">
					{!hasQuery ? (
						<EmptyState
							recentSearches={recentSearches}
							recentObjects={recentObjects}
							onRecentSearchClick={runRecentSearch}
							onRecentObjectClick={openObject}
						/>
					) : searchRequested && !results ? (
						<div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>
					) : results && results.length > 0 ? (
						<>
							<p className="pb-3 text-[13px] text-muted-foreground">
								<strong className="text-foreground">{results.length}</strong> result
								{results.length === 1 ? '' : 's'} for{' '}
								<strong className="text-foreground">“{query}”</strong>
								{typeFilterLabel ? ` · ${typeFilterLabel}` : ''}
								{statusFilterLabel ? ` · ${statusFilterLabel}` : ''}
							</p>
							<ul className="flex flex-col gap-0.5">
								{results.map((obj) => (
									<li key={obj.id}>
										<button
											type="button"
											onClick={() => openObject(obj)}
											className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent max-sm:min-h-11"
										>
											<span className="text-sm font-medium text-foreground">
												{highlightText(obj.title ?? 'Untitled', query)}
											</span>
											{obj.content ? (
												<span className="line-clamp-2 text-xs text-muted-foreground">
													{highlightText(obj.content, query)}
												</span>
											) : null}
											<span className="mt-1 flex items-center gap-1.5">
												<TypeBadge type={obj.type} />
												<StatusBadge status={obj.status} />
												<RelativeTime
													date={obj.updatedAt}
													className="text-[11px] text-muted-foreground"
												/>
											</span>
										</button>
									</li>
								))}
							</ul>
						</>
					) : (
						<div className="py-12 text-center">
							<p className="text-[15px] font-semibold text-foreground">No results for “{query}”</p>
							<p className="mt-1 text-[13px] text-muted-foreground">
								Try a different term, or clear one of the filters above.
							</p>
							<p className="mt-3 text-xs text-muted-foreground">
								<span className="mr-2">
									<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>{' '}
									clears the query
								</span>
								<span>
									<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>{' '}
									reopens the palette
								</span>
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

function EmptyState({
	recentSearches,
	recentObjects,
	onRecentSearchClick,
	onRecentObjectClick,
}: {
	recentSearches: string[]
	recentObjects: ObjectResponse[]
	onRecentSearchClick: (query: string) => void
	onRecentObjectClick: (obj: ObjectResponse) => void
}) {
	return (
		<div>
			<p className="pb-2 text-[13px] text-muted-foreground">
				Search everything — objects, bets, tasks. Filters apply after you type.
			</p>
			{recentSearches.length > 0 && (
				<section aria-label="Recent searches">
					<h2 className="pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Recent searches
					</h2>
					<ul className="flex flex-col">
						{recentSearches.map((q) => (
							<li key={q}>
								<button
									type="button"
									onClick={() => onRecentSearchClick(q)}
									className="flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent max-sm:min-h-11"
								>
									<span className="font-medium">{q}</span>
									<span className="text-xs text-muted-foreground">Search</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
			{recentObjects.length > 0 && (
				<section aria-label="Recent objects">
					<h2 className="pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Recent objects
					</h2>
					<ul className="flex flex-col">
						{recentObjects.map((obj) => (
							<li key={obj.id}>
								<button
									type="button"
									onClick={() => onRecentObjectClick(obj)}
									className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent max-sm:min-h-11"
								>
									<span className="min-w-0 flex-1 truncate font-medium text-foreground">
										{obj.title ?? 'Untitled'}
									</span>
									<span className="shrink-0 text-xs text-muted-foreground">
										{typeLabel(obj.type)} · {statusLabel(obj.status)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	)
}
