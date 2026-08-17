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
import { cn } from '@/lib/cn'
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
import { ArrowLeft, Clock, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const SEARCH_DEBOUNCE_MS = 300

// Fallback workflow statuses. Custom statuses from workspace settings (per
// object type) union over this — the filter chips always reflect the
// workspace's real vocabulary.
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

	// Input syncs from URL `q` so deep links, the palette's See-all footer, and
	// back/forward all restore the box. URL is source of truth; local state
	// only smooths typing before the debounce lands.
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
	// The ref guard makes it fire exactly once per mount despite StrictMode's
	// dev double-effect, matching the funnel's exactly-one denominator.
	const emittedSearchViewOpen = useRef(false)
	useEffect(() => {
		if (emittedSearchViewOpen.current) return
		emittedSearchViewOpen.current = true
		trackCommandPaletteOpened({ surface: 'search_view' })
	}, [])

	// Search is keyboard-first; focus the input on entry so a typed query
	// lands immediately (a11y rule prefers programmatic focus over autoFocus).
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

	// Debounced URL commit — the shared server search keys off URL `q`, so
	// typing never fires a request per keystroke.
	useEffect(() => {
		const trimmed = input.trim()
		if (trimmed === (searchParamsRef.current.q ?? '')) return
		const t = setTimeout(() => updateSearch({ q: trimmed || undefined }), SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(t)
	}, [input, updateSearch])

	const { data: results } = useSearchObjects(workspaceId, {
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

	const typeChips = useMemo(
		() => [
			{ label: 'All types', value: undefined as string | undefined },
			...TYPE_FILTERS.map((type) => ({
				label: typeLabel(type),
				value: type as string | undefined,
			})),
		],
		[],
	)
	const statusChips = useMemo(() => {
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
			{ label: 'Any status', value: undefined as string | undefined },
			...statuses.map((status) => ({
				label: statusLabel(status),
				value: status as string | undefined,
			})),
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
	// "Searching…" only while a query is committed and no results have
	// arrived yet. Otherwise the loading branch flashes "No results" on the
	// first query.
	const searchRequested = hasQuery && !results

	const typeFilterLabel = search.type ? typeLabel(search.type) : undefined
	const statusFilterLabel = search.status ? statusLabel(search.status) : undefined

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
			{/* Header — back button, search input, Esc hint. Matches the v2
			    mockup's page-header row: flush, warm neutral, no glass. */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2 md:px-5">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Back"
					onClick={() => router.history.back()}
					className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft aria-hidden="true" className="size-4" />
				</Button>
				<Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				<input
					ref={inputRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Search everything…"
					aria-label="Search"
					className="h-9 w-full min-w-0 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<kbd className="hidden shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex">
					Esc
				</kbd>
			</div>

			{/* Filter bar — v2 chip shape (h-7 rounded-full border) matching the
			    TopNav filter chips. Eyebrow labels replace the old uppercase
			    caps. Scrolls as one row on mobile. */}
			<div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-background px-3 py-2 md:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				<span className="eyebrow shrink-0">Type</span>
				<ChipRow
					aria-label="Filter by type"
					chips={typeChips}
					value={search.type}
					onChange={(type) => updateSearch({ type })}
				/>
				<span className="eyebrow shrink-0">Status</span>
				<ChipRow
					aria-label="Filter by status"
					chips={statusChips}
					value={search.status}
					onChange={(status) => updateSearch({ status })}
				/>
			</div>

			{/* Content */}
			<div className="mx-auto w-full max-w-[900px] flex-1 overflow-y-auto">
				<div className="px-3 pb-8 pt-5 md:px-5">
					{!hasQuery ? (
						<EmptyState
							recentSearches={recentSearches}
							recentObjects={recentObjects}
							onRecentSearchClick={runRecentSearch}
							onRecentObjectClick={openObject}
						/>
					) : searchRequested && !results ? (
						<div className="py-10 text-center text-[13px] text-muted-foreground">Searching…</div>
					) : results && results.length > 0 ? (
						<>
							<p className="pb-3 text-[13px] text-muted-foreground">
								<strong className="font-semibold text-foreground">{results.length}</strong> result
								{results.length === 1 ? '' : 's'} for{' '}
								<strong className="font-semibold text-foreground">"{query}"</strong>
								{typeFilterLabel ? ` · ${typeFilterLabel}` : ''}
								{statusFilterLabel ? ` · ${statusFilterLabel}` : ''}
							</p>
							<ul className="flex flex-col gap-0.5">
								{results.map((obj) => (
									<li key={obj.id}>
										<button
											type="button"
											onClick={() => openObject(obj)}
											className="flex w-full flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent max-sm:min-h-11"
										>
											<span className="text-[13.5px] font-semibold text-foreground">
												{highlightText(obj.title ?? 'Untitled', query)}
											</span>
											{obj.content ? (
												<span className="line-clamp-2 text-[12.5px] text-muted-foreground">
													{highlightText(obj.content, query)}
												</span>
											) : null}
											<span className="mt-1 flex items-center gap-1.5">
												<TypeBadge type={obj.type} variant="mono" />
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
						<div className="py-14 text-center">
							<p className="text-[15px] font-semibold text-foreground">No results for "{query}"</p>
							<p className="mt-1 text-[13px] text-muted-foreground">
								Try a different term, or clear one of the filters above.
							</p>
							<p className="mt-4 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
								<span className="inline-flex items-center gap-1.5">
									<kbd className="inline-flex h-4 items-center rounded-md border border-border bg-secondary px-1.5 font-mono text-[10px]">
										Esc
									</kbd>
									clears the query
								</span>
								<span className="inline-flex items-center gap-1.5">
									<kbd className="inline-flex h-4 items-center rounded-md border border-border bg-secondary px-1.5 font-mono text-[10px]">
										⌘K
									</kbd>
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

// v2 chip — same shape as the TopNav filter chips. Kept inline instead of
// pulling into shared FilterTabs so the shared component's other callers
// aren't dragged into the restyle prematurely.
function ChipRow({
	chips,
	value,
	onChange,
	'aria-label': ariaLabel,
}: {
	chips: Array<{ label: string; value: string | undefined }>
	value: string | undefined
	onChange: (value: string | undefined) => void
	'aria-label': string
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: role="group" fits a chip toggle strip better than <fieldset>
		<div
			role="group"
			aria-label={ariaLabel}
			className="flex shrink-0 items-center gap-1.5 max-sm:[&>button]:min-h-11"
		>
			{chips.map((chip) => {
				const isActive = chip.value === value
				return (
					<button
						key={chip.label}
						type="button"
						aria-pressed={isActive}
						onClick={() => onChange(chip.value)}
						className={cn(
							'inline-flex h-7 items-center whitespace-nowrap rounded-full border px-3 text-[11.5px] font-semibold transition-colors',
							isActive
								? 'border-border-strong bg-secondary text-foreground'
								: 'border-border bg-background text-muted-foreground hover:border-border-strong hover:text-foreground',
						)}
					>
						{chip.label}
					</button>
				)
			})}
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
	if (recentSearches.length === 0 && recentObjects.length === 0) {
		return (
			<div className="mx-auto max-w-md py-12 text-center">
				<Search aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
				<p className="text-[13.5px] font-semibold text-foreground">
					Search everything — objects, bets, tasks
				</p>
				<p className="mt-1 text-[12.5px] text-muted-foreground">
					Filters apply after you type. Recent searches and objects show up here.
				</p>
			</div>
		)
	}
	return (
		<div className="flex flex-col gap-6">
			<p className="text-[13px] text-muted-foreground">
				Search everything — objects, bets, tasks. Filters apply after you type.
			</p>
			{recentSearches.length > 0 && (
				<section aria-label="Recent searches">
					<h2 className="eyebrow pb-2">Recent searches</h2>
					<ul className="flex flex-col">
						{recentSearches.map((q) => (
							<li key={q}>
								<button
									type="button"
									onClick={() => onRecentSearchClick(q)}
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-accent max-sm:min-h-11"
								>
									<Clock aria-hidden="true" className="size-3.5 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate font-medium">{q}</span>
									<span className="shrink-0 text-[11px] text-muted-foreground">Search</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
			{recentObjects.length > 0 && (
				<section aria-label="Recent objects">
					<h2 className="eyebrow pb-2">Recent objects</h2>
					<ul className="flex flex-col">
						{recentObjects.map((obj) => (
							<li key={obj.id}>
								<button
									type="button"
									onClick={() => onRecentObjectClick(obj)}
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent max-sm:min-h-11"
								>
									<span className="min-w-0 flex-1 truncate font-medium text-foreground">
										{obj.title ?? 'Untitled'}
									</span>
									<TypeBadge type={obj.type} variant="mono" />
									<StatusBadge status={obj.status} />
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	)
}
