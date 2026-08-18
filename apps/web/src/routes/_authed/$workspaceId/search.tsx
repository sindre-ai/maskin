import { PageHeader } from '@/components/layout/page-header'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { useObjects } from '@/hooks/use-objects'
import {
	SEARCH_GROUPS,
	SEARCH_GROUP_LABEL,
	type SearchGroup,
	type SearchRow,
	useWorkspaceSearch,
} from '@/hooks/use-workspace-search'
import {
	type TaxonomyEntityType,
	trackCommandPaletteOpened,
	trackSearchResultOpened,
} from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useCommandPalette } from '@/lib/command-palette-context'
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
import { ArrowLeft, MessageSquare, RefreshCw, Search, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const SEARCH_DEBOUNCE_MS = 300

// Fallback workflow statuses. Custom statuses from workspace settings (per
// object type) union over this — the filter chips always reflect the
// workspace's real vocabulary.
const DEFAULT_STATUS_FILTERS = ['active', 'in_progress', 'todo', 'define', 'in_review', 'done']

const TYPE_FILTERS = ['insight', 'bet', 'task'] as const

const GROUP_VALUES = new Set<string>(SEARCH_GROUPS)

interface SearchParams {
	q?: string
	type?: string
	status?: string
	group?: string
}

export const Route = createFileRoute('/_authed/$workspaceId/search')({
	component: SearchView,
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		q: typeof search.q === 'string' ? search.q : undefined,
		type: typeof search.type === 'string' ? search.type : undefined,
		status: typeof search.status === 'string' ? search.status : undefined,
		group:
			typeof search.group === 'string' && GROUP_VALUES.has(search.group) ? search.group : undefined,
	}),
})

function SearchView() {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const router = useRouter()
	const search = useSearch({ from: '/_authed/$workspaceId/search' })
	const { setOpen: setPaletteOpen } = useCommandPalette()
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

	const query = (search.q ?? '').trim()
	const hasQuery = query.length > 0
	const activeGroup = search.group as SearchGroup | undefined

	// Recents are the page's job: neither NavSearch nor the command palette
	// writes them, so keying off the *committed* query covers page-typed,
	// nav-committed and palette-committed searches in one place. The list is
	// held in state so it re-reads localStorage right after each write.
	const [recentSearches, setRecentSearches] = useState(() =>
		getRecentSearches(workspaceId).slice(0, 4),
	)
	useEffect(() => {
		if (query) pushRecentSearch(workspaceId, query)
		setRecentSearches(getRecentSearches(workspaceId).slice(0, 4))
	}, [query, workspaceId])

	const { rows, countsByGroup, total, isPending } = useWorkspaceSearch(workspaceId, {
		q: query,
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
	const recentObjects = useMemo(
		() =>
			getRecentObjectIds(workspaceId)
				.map((id) => objectById.get(id))
				.filter(Boolean) as ObjectResponse[],
		[objectById, workspaceId],
	)

	const groupChips = useMemo(() => {
		const chips: Array<{ label: string; value: string | undefined; count: number }> = [
			{ label: 'All', value: undefined, count: total },
		]
		for (const group of SEARCH_GROUPS) {
			const count = countsByGroup[group]
			// Only groups with hits get a chip (mockup 2526–2529).
			if (count === 0) continue
			chips.push({ label: SEARCH_GROUP_LABEL[group], value: group, count })
		}
		return chips
	}, [countsByGroup, total])

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

	const openRow = useCallback(
		(row: SearchRow) => {
			if (row.object) {
				openObject(row.object)
				return
			}
			navigate({ to: row.to, params: row.params })
		},
		[navigate, openObject],
	)

	const runRecentSearch = useCallback(
		(searchQuery: string) => {
			pushRecentSearch(workspaceId, searchQuery)
			setInput(searchQuery)
			updateSearch({ q: searchQuery })
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

	const visibleRows = activeGroup ? rows.filter((row) => row.group === activeGroup) : rows
	const visibleCount = visibleRows.length
	// "Searching…" only while a query is committed and no results have arrived
	// yet. Otherwise the loading branch flashes the no-match state.
	const searchRequested = hasQuery && isPending
	// The Type/Status selectors only ever narrow objects, so they stay out of
	// the way while another group is pinned.
	const showObjectFilters = !activeGroup || activeGroup === 'objects'

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
			<PageHeader
				stickyIdentity={<SearchHeaderIdentity count={hasQuery ? visibleCount : undefined} />}
			/>

			{/* Header — back button, search input, Esc hint. The nav's search field
			    is a launcher (Enter commits and navigates here); this is the
			    refinement surface, so the page owns its own input. */}
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

			{hasQuery ? (
				<div className="flex shrink-0 flex-col gap-2 border-b border-border bg-background px-3 py-2 md:px-5">
					{/* Entity groups (mockup 2526–2531) — only groups with hits, each
					    with its count, and the result line right-aligned. */}
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<FilterTabs
							aria-label="Filter by group"
							variant="pill"
							tabs={groupChips}
							value={search.group}
							onChange={(group) => updateSearch({ group })}
							className="min-w-0 max-sm:[&>button]:min-h-11"
						/>
						<p className="ml-auto min-w-0 max-w-full truncate text-[11.5px] text-muted-foreground">
							{visibleCount} result{visibleCount === 1 ? '' : 's'} for{' '}
							<strong className="font-semibold text-foreground">"{query}"</strong>
						</p>
					</div>

					{showObjectFilters ? (
						<div className="flex min-w-0 items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
							<span className="eyebrow shrink-0">Type</span>
							<FilterTabs
								aria-label="Filter by type"
								variant="pill"
								tabs={typeChips}
								value={search.type}
								onChange={(type) => updateSearch({ type })}
								className="max-sm:[&>button]:min-h-11"
							/>
							<span className="eyebrow shrink-0">Status</span>
							<FilterTabs
								aria-label="Filter by status"
								variant="pill"
								tabs={statusChips}
								value={search.status}
								onChange={(status) => updateSearch({ status })}
								className="max-sm:[&>button]:min-h-11"
							/>
						</div>
					) : null}
				</div>
			) : null}

			{/* Content */}
			<div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col overflow-y-auto">
				{!hasQuery ? (
					<SearchIdleState
						recentSearches={recentSearches}
						recentObjects={recentObjects}
						onRecentSearchClick={runRecentSearch}
						onRecentObjectClick={openObject}
						onOpenPalette={() => setPaletteOpen(true)}
					/>
				) : searchRequested ? (
					<div className="px-3 py-10 text-center text-[13px] text-muted-foreground md:px-5">
						Searching…
					</div>
				) : visibleCount > 0 ? (
					<div className="px-3 pb-8 pt-3 md:px-5">
						{SEARCH_GROUPS.map((group) => {
							const groupRows = visibleRows.filter((row) => row.group === group)
							if (groupRows.length === 0) return null
							return (
								<section key={group} aria-label={SEARCH_GROUP_LABEL[group]}>
									<h2 className="eyebrow px-1 pb-1 pt-3">
										{SEARCH_GROUP_LABEL[group]} · {groupRows.length}
									</h2>
									<ul className="flex flex-col gap-0.5">
										{groupRows.map((row) => (
											<li key={`${row.group}-${row.id}`}>
												<ResultRow row={row} query={query} onOpen={openRow} />
											</li>
										))}
									</ul>
								</section>
							)
						})}
					</div>
				) : (
					<EmptyState
						emphasis="page"
						title={`Nothing matches "${query}"`}
						description="Search looks across chats, loops, agents, objects and automations. Try a shorter word — or run a command instead."
						action={
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setPaletteOpen(true)}
							>
								Open commands
								<kbd className="font-mono text-[10px] text-muted-foreground">⌘K</kbd>
							</Button>
						}
					/>
				)}
			</div>
		</div>
	)
}

// Title + count for the shared nav's sticky-identity slot (mockup 188–191),
// mirroring MarketplaceHeaderIdentity so the two screens read identically.
function SearchHeaderIdentity({ count }: { count: number | undefined }) {
	return (
		<div className="flex min-w-0 items-baseline gap-2" data-testid="search-header-identity">
			<h1 className="truncate text-base font-semibold text-foreground">Search</h1>
			{/* Hidden below `sm` so the 375px header keeps room for NavSearch —
			    same pattern the shared header uses for its own subtitle. */}
			<span
				className="hidden shrink-0 text-sm text-muted-foreground sm:inline"
				data-testid="search-count"
			>
				{typeof count === 'number'
					? `${count} match${count === 1 ? '' : 'es'}`
					: 'everything, in one place'}
			</span>
		</div>
	)
}

const GROUP_GLYPH: Partial<Record<SearchGroup, typeof MessageSquare>> = {
	chats: MessageSquare,
	loops: RefreshCw,
	automations: Zap,
}

/** One result row (mockup 2536–2545): leading visual, truncated title with a
 *  muted sub-line suffix, single-line snippet, trailing kind column. */
function ResultRow({
	row,
	query,
	onOpen,
}: {
	row: SearchRow
	query: string
	onOpen: (row: SearchRow) => void
}) {
	const Glyph = GROUP_GLYPH[row.group]
	return (
		<button
			type="button"
			onClick={() => onOpen(row)}
			className="flex w-full items-start gap-[11px] rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent max-sm:min-h-11"
		>
			{row.object ? (
				<TypeBadge
					type={row.object.type}
					variant="tile"
					className="mt-px size-[22px] shrink-0 rounded-md"
				/>
			) : row.group === 'agents' ? (
				<ActorAvatar
					id={row.id}
					name={row.title}
					type="agent"
					className="mt-px size-[22px] shrink-0 text-[9px]"
				/>
			) : Glyph ? (
				<span
					aria-hidden="true"
					className="mt-px grid size-[22px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
				>
					<Glyph className="size-[13px]" />
				</span>
			) : null}

			<span className="flex min-w-0 flex-1 flex-col gap-[3px]">
				<span className="truncate text-[13px] font-semibold text-foreground">
					{highlightText(row.title, query)}
					{row.sub ? <span className="font-normal text-muted-foreground"> — {row.sub}</span> : null}
				</span>
				{row.snippet ? (
					<span className="truncate text-[11.5px] leading-normal text-muted-foreground">
						{highlightText(row.snippet, query)}
					</span>
				) : null}
			</span>

			{/* One uniform kind column for every result type (mockup 2544) — an
			    object's status rides the muted title suffix instead of a pill, so
			    cross-entity rows stay scannable down a single edge. */}
			<span className="mt-0.5 shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.05em] text-muted-foreground">
				{row.kind}
			</span>
		</button>
	)
}

/** The idle (no-query) screen — vertically centred title + description, the
 *  RECENT pill row, the ⌘K nudge, and the recently-opened objects list. */
function SearchIdleState({
	recentSearches,
	recentObjects,
	onRecentSearchClick,
	onRecentObjectClick,
	onOpenPalette,
}: {
	recentSearches: string[]
	recentObjects: ObjectResponse[]
	onRecentSearchClick: (query: string) => void
	onRecentObjectClick: (obj: ObjectResponse) => void
	onOpenPalette: () => void
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-6 px-3 py-8 md:px-5">
			<EmptyState
				emphasis="page"
				className="py-0"
				title="Search the workspace"
				description="Chats, loops, agents, objects and automations — everything you and the agents have touched, in one result list you can filter."
				action={
					<div className="flex flex-col items-center gap-4">
						{recentSearches.length > 0 ? (
							<div className="flex max-w-[520px] flex-wrap items-center justify-center gap-2">
								<span className="eyebrow">Recent</span>
								{recentSearches.map((recent) => (
									<button
										key={recent}
										type="button"
										onClick={() => onRecentSearchClick(recent)}
										className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-transparent px-3 text-[11.5px] font-semibold text-muted-foreground transition-colors duration-150 hover:border-border-hover hover:text-foreground max-sm:min-h-11"
									>
										{recent}
									</button>
								))}
							</div>
						) : null}
						<p className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-dashed border-input px-3 py-2 text-[11.5px] text-muted-foreground">
							Want to jump somewhere or start something instead?
							<Button type="button" variant="outline" size="sm" onClick={onOpenPalette}>
								<kbd className="font-mono text-[10px]">⌘K</kbd>
							</Button>
						</p>
					</div>
				}
			/>

			{recentObjects.length > 0 ? (
				<section aria-label="Recent objects" className="w-full max-w-[520px]">
					<h2 className="eyebrow pb-2">Recent objects</h2>
					<ul className="flex flex-col">
						{recentObjects.map((obj) => (
							<li key={obj.id}>
								<button
									type="button"
									onClick={() => onRecentObjectClick(obj)}
									className={cn(
										'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent',
										'max-sm:min-h-11',
									)}
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
			) : null}
		</div>
	)
}
