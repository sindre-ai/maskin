import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useObjects } from '@/hooks/use-objects'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useParticipantMenu, useParticipantOptions } from '@/hooks/use-participant-menu'
import { useSearchFieldHandlers } from '@/hooks/use-search-field-handlers'
import {
	SEARCH_QUERY_DEBOUNCE_MS,
	hasSearchInput,
	useDebouncedValue,
	useSearchQuery,
} from '@/hooks/use-search-query'
import { useSearchState } from '@/hooks/use-search-state'
import { humanize, useSearchVocabulary } from '@/hooks/use-search-vocabulary'
import { type SearchEntry, trackCommandPaletteOpened } from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useCommandPalette } from '@/lib/command-palette-context'
import { getRecentObjectIds, pushRecentObject } from '@/lib/search-recents'
import {
	searchEntityType,
	trackSearchRowOpened,
	useTrackSettledSearchV2,
} from '@/lib/search-telemetry'
import {
	type TypeOption,
	buildStatusChips,
	buildTypeChips,
	failedTypeKeys,
} from '@/lib/search/chips'
import { explainEmpty } from '@/lib/search/empty-state'
import { PARTICIPANT_FILTER_FLAG } from '@/lib/search/mention'
import { navigateToSearchRow } from '@/lib/search/open-row'
import { hasPill, queryText } from '@/lib/search/parts'
import { shortcutLabel } from '@/lib/search/platform'
import {
	type RecentSearch,
	getRecentSearchEntries,
	pushRecentSearchEntry,
} from '@/lib/search/recents'
import { parseSearchState, serializeSearchState } from '@/lib/search/url-state'
import { type Vocabulary, pillLabel } from '@/lib/search/vocabulary'
import { useWorkspace } from '@/lib/workspace-context'
import type { SearchResponse, SearchResultRow } from '@maskin/shared'
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { DisplayMenu } from './display-menu'
import { ParticipantMenu } from './participant-menu'
import { StatusChips, TypeChips } from './search-chips'
import { SearchField } from './search-field'
import { SearchResultList, optionId, orderRows } from './search-results'
import {
	CapNotice,
	EmptyResults,
	OfflineNotice,
	PartialNotice,
	ResultsError,
	ResultsSkeleton,
	SlowNotice,
} from './search-states'

const SLOW_AFTER_MS = 3000
const TIMEOUT_AFTER_MS = 10_000

type Pace = 'ok' | 'slow' | 'timeout'

/** How long the current request has been running: fine, slow after 3s, given up after 10s. */
function useRequestPace(active: boolean, requestKey: string): Pace {
	const [pace, setPace] = useState<Pace>('ok')
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new request restarts the clock
	useEffect(() => {
		setPace('ok')
		if (!active) return
		const slow = setTimeout(() => setPace('slow'), SLOW_AFTER_MS)
		const timeout = setTimeout(() => setPace('timeout'), TIMEOUT_AFTER_MS)
		return () => {
			clearTimeout(slow)
			clearTimeout(timeout)
		}
	}, [active, requestKey])
	return pace
}

export function SearchPageV2() {
	useDocumentTitle('Search')
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const router = useRouter()
	const search = useSearch({ from: '/_authed/$workspaceId/search' })
	const { setOpen: setPaletteOpen } = useCommandPalette()
	const online = useOnlineStatus()
	const objectTypes = useAvailableObjectTypes()
	const inputRef = useRef<HTMLInputElement>(null)
	const listboxId = useId()

	// The words and filters this page knows about, from real workspace types.
	const vocab = useSearchVocabulary()

	// Chats, Loops, Agents, People, then the workspace's object types, then Automations.
	const typeOptions = useMemo<TypeOption[]>(
		() => [
			{ key: 'chat', label: 'Chats' },
			{ key: 'loop', label: 'Loops' },
			{ key: 'agent', label: 'Agents' },
			{ key: 'person', label: 'People' },
			...objectTypes
				.filter((t) => t.value !== 'loop')
				.map((t) => ({ key: t.value, label: t.label })),
			{ key: 'automation', label: 'Automations' },
		],
		[objectTypes],
	)

	// Off, a participants param in a link is ignored and the next URL write drops it.
	const participantFilterOn = useFeatureFlag(PARTICIPANT_FILTER_FLAG)
	const urlState = useMemo(() => {
		const parsed = parseSearchState(search as Record<string, unknown>)
		return participantFilterOn ? parsed : { ...parsed, participants: [] }
	}, [search, participantFilterOn])
	const urlKey = JSON.stringify(serializeSearchState(urlState))
	const { state, dispatch, suggestion, types, statuses, participants } = useSearchState(
		vocab,
		urlState,
	)
	const { parts, updated, sort } = state

	// How this search began, for analytics: a link or reload, typing, a recent search.
	const [entry, setEntry] = useState<SearchEntry>(urlKey === '{}' ? 'typed' : 'url')

	// One `command_palette_opened` per mount: the search-page half of the funnel denominator.
	const emittedOpen = useRef(false)
	useEffect(() => {
		if (emittedOpen.current) return
		emittedOpen.current = true
		trackCommandPaletteOpened({ surface: 'search_view' })
	}, [])

	// Search is keyboard-first: focus the field on entry.
	useEffect(() => {
		inputRef.current?.focus()
	}, [])

	// URL <-> state. State is the live truth; the URL gets a copy once the words have
	// settled, so a reload or a shared link restores the view. Writes that come back
	// as a URL change are our own echo and must not reset the field while the person
	// keeps typing; anything else (back, a link, the launcher) is read into the state.
	const debouncedText = useDebouncedValue(parts.text, SEARCH_QUERY_DEBOUNCE_MS)
	const committedKey = JSON.stringify(
		serializeSearchState({ text: debouncedText, types, statuses, participants, updated, sort }),
	)
	const pendingWrites = useRef<string[]>([])
	// biome-ignore lint/correctness/useExhaustiveDependencies: urlKey only tells whether a write is needed
	useEffect(() => {
		if (committedKey === urlKey) return
		pendingWrites.current.push(committedKey)
		navigate({
			to: '/$workspaceId/search',
			params: { workspaceId },
			search: JSON.parse(committedKey),
			replace: true,
		})
	}, [committedKey, navigate, workspaceId])
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the URL changes, not on every state change
	useEffect(() => {
		const index = pendingWrites.current.indexOf(urlKey)
		if (index >= 0) {
			pendingWrites.current.splice(0, index + 1)
			return
		}
		pendingWrites.current = []
		dispatch({ type: 'hydrate', state: urlState })
		if (urlKey !== '{}') setEntry('url')
	}, [urlKey])

	// The words the current answer is for (the typed text lags it by the debounce).
	const query = queryText({ ...parts, text: debouncedText })
	const input = { text: debouncedText, types, statuses, participants, updated, sort }
	const enabled = hasSearchInput(input)
	const result = useSearchQuery(workspaceId, input)
	const { data, isError, isFetching, isPlaceholderData, refetch } = result

	// The last good answer keeps the chips honest while a request fails or is slow. It
	// remembers the words it answered, so the count line never pairs it with newer words.
	const lastAnswer = useRef<{ data: SearchResponse; query: string } | undefined>(undefined)
	if (data && !isPlaceholderData) lastAnswer.current = { data, query }
	// Nothing asked (idle): the chips are plain filters, with no counts from an earlier search.
	const facets = enabled ? ((data ?? lastAnswer.current?.data)?.facets ?? null) : null

	// Retry restarts the pace clock too, even though the request was already in flight.
	const [retries, setRetries] = useState(0)
	const retry = () => {
		setRetries((n) => n + 1)
		refetch()
	}
	const pace = useRequestPace(enabled && isFetching && online, JSON.stringify([input, retries]))

	const settled = Boolean(data) && !isPlaceholderData && !isFetching && !isError
	useTrackSettledSearchV2({
		active: enabled,
		query: debouncedText,
		types,
		statuses,
		updated,
		sort,
		entry,
		isSettled: settled,
		isPartial: (data?.partial.length ?? 0) > 0,
		total: data?.total ?? 0,
	})

	const results = data?.results ?? []
	const ordered = useMemo(() => orderRows(results, sort), [results, sort])

	// Up and Down move the highlighted result while focus stays in the field.
	const [activeIndex, setActiveIndex] = useState(-1)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new answer clears the highlight
	useEffect(() => {
		setActiveIndex(-1)
	}, [data])
	const activeRow = activeIndex >= 0 ? ordered[activeIndex] : undefined
	const activeId = activeRow ? optionId(listboxId, activeRow) : undefined
	useEffect(() => {
		if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
	}, [activeId])

	const [announcement, setAnnouncement] = useState('')

	// Back steps back in the app; a page opened from a link has no app history to step
	// back into, and going back would leave the app, so it goes to For you.
	const goBack = () => {
		if (router.history.canGoBack()) router.history.back()
		else navigate({ to: '/$workspaceId', params: { workspaceId } })
	}

	const {
		track,
		onTextChange,
		onAcceptSuggestion,
		onBackspaceToWord,
		onRemovePill,
		onPickParticipant,
	} = useSearchFieldHandlers({
		surface: 'search_view',
		parts,
		vocab,
		suggestion,
		dispatch,
		inputRef,
		onEdit: () => setEntry('typed'),
	})
	const participantOptions = useParticipantOptions(vocab)
	const menu = useParticipantMenu({
		parts,
		options: participantOptions,
		onPick: onPickParticipant,
	})
	const onDismissSuggestion = () => {
		dispatch({ type: 'dismiss' })
		setAnnouncement('Suggestion dismissed')
	}
	const toggleFilter = (
		kind: 'type' | 'status',
		value: string,
		from: 'chip' | 'display_menu' = 'chip',
	) => {
		track({
			dimension: kind,
			action: hasPill(parts, kind, value) ? 'remove' : 'add',
			value,
			kind: from,
			via: 'click',
		})
		setEntry('typed')
		dispatch({ type: kind === 'type' ? 'toggleType' : 'toggleStatus', value })
	}
	const clearFilters = () => {
		track({ dimension: 'clear', action: 'reset', value: '', kind: 'clear_button', via: 'click' })
		dispatch({ type: 'clearFilters' })
		inputRef.current?.focus()
	}

	const filtersActive = parts.pills.length > 0 || updated !== ''

	const openRow = (row: SearchResultRow) => {
		trackSearchRowOpened({
			surface: 'search_view',
			entityId: row.id,
			entityType: searchEntityType(row.group, row.type),
			group: row.group,
			position: ordered.indexOf(row) + 1,
			hasQuery: query !== '',
			listSize: ordered.length,
			uiVersion: 'v2',
		})
		pushRecentSearchEntry(workspaceId, { q: query, types, statuses })
		if (row.group === 'objects') pushRecentObject(workspaceId, row.id)
		navigateToSearchRow(navigate, workspaceId, row)
	}

	const moveActive = (delta: 1 | -1) => {
		const n = ordered.length
		if (n === 0) return
		setActiveIndex((i) => (i < 0 ? (delta === 1 ? 0 : n - 1) : (i + delta + n) % n))
	}

	const partial = (data?.partial.length ?? 0) > 0
	const typeChips = buildTypeChips({
		options: typeOptions,
		counts: facets?.types ?? null,
		selected: types,
		fallbackLabel: humanize,
		// A source that failed has no count; its chip stays with a dash.
		failed: failedTypeKeys(
			data?.partial ?? [],
			typeOptions.map((o) => o.key),
		),
	})
	const statusChips = buildStatusChips({ counts: facets?.statuses ?? null, selected: statuses })
	const staleChips = enabled && !data

	// What fills the content area.
	// Failed, offline with nothing to show, or no answer after 10 seconds. The field and chips stay.
	// Offline, the old rows are not an answer to the new words: show the offline block.
	const failed = ((isError || !online) && (!data || isPlaceholderData)) || pace === 'timeout'
	const showSkeleton = enabled && !data && !failed && online
	const showEmpty = Boolean(data) && data?.total === 0
	const showList = Boolean(data) && (data?.total ?? 0) > 0

	// While the answer on screen is a stand-in for the new words (slow or offline), the
	// count line keeps the old total with the old words instead of claiming it for the new.
	const counted = isPlaceholderData ? lastAnswer.current : data ? { data, query } : undefined
	const countText =
		counted && !showSkeleton
			? `${counted.data.total} result${counted.data.total === 1 ? '' : 's'}`
			: null
	const countQuery = counted?.query ?? query

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
			<PageHeader title="Search" subtitle="everything, in one place" />

			<div className="shrink-0 border-b border-border bg-background px-3 py-3 md:px-5">
				<div className="mx-auto flex w-full max-w-[900px] flex-col gap-2.5">
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Back"
							onClick={goBack}
							className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground max-[1024.02px]:size-11"
						>
							<ArrowLeft aria-hidden="true" className="size-4" />
						</Button>
						<div className="relative flex min-w-0 flex-1">
							<SearchField
								parts={parts}
								vocab={vocab}
								suggestion={suggestion}
								inputRef={inputRef}
								listboxId={listboxId}
								activeOptionId={activeId}
								listboxOpen={showList}
								menu={menu}
								onTextChange={onTextChange}
								onAcceptSuggestion={onAcceptSuggestion}
								onDismissSuggestion={onDismissSuggestion}
								onBackspaceToWord={onBackspaceToWord}
								onRemovePill={onRemovePill}
								onClearText={() => dispatch({ type: 'text', text: '' })}
								onMoveActive={moveActive}
								onOpenActive={() => activeRow && openRow(activeRow)}
								onEscape={() => {
									// Esc clears the words first; with nothing left it steps back.
									if (parts.text) dispatch({ type: 'text', text: '' })
									else goBack()
								}}
							/>
							{menu.open ? (
								<ParticipantMenu
									rows={menu.rows}
									activeIndex={menu.activeIndex}
									listboxId={menu.listboxId}
									onPick={menu.pick}
									className="absolute inset-x-0 top-full z-20 mt-1"
								/>
							) : null}
						</div>
					</div>

					<TypeChips
						chips={typeChips}
						dimmed={staleChips}
						// With nothing asked there is no answer coming, so no dash either.
						showCounts={enabled}
						onToggle={(key) => toggleFilter('type', key)}
					/>
					<div className="flex items-start gap-2">
						<StatusChips
							chips={statusChips}
							dimmed={staleChips}
							showCounts={enabled}
							onToggle={(key) => toggleFilter('status', key)}
						/>
						<DisplayMenu
							sort={sort}
							updated={updated}
							typeChips={typeChips}
							onSortChange={(value) => {
								track({
									dimension: 'sort',
									action: value === 'rel' ? 'reset' : 'set',
									value,
									kind: 'display_menu',
									via: 'click',
								})
								dispatch({ type: 'setSort', value })
							}}
							onUpdatedChange={(value) => {
								track({
									dimension: 'updated',
									action: value === '' ? 'reset' : 'set',
									value: value || 'any',
									kind: 'display_menu',
									via: 'click',
								})
								dispatch({ type: 'setUpdated', value })
							}}
							onToggleType={(key) => toggleFilter('type', key, 'display_menu')}
						/>
					</div>

					{enabled ? (
						<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
							{showSkeleton ? (
								<p className="text-[11.5px] text-muted-foreground">Searching…</p>
							) : countText ? (
								<p className="min-w-0 max-w-full truncate text-[11.5px] text-muted-foreground">
									{countText}
									{countQuery ? (
										<>
											{' for '}
											<strong className="font-semibold text-foreground">“{countQuery}”</strong>
										</>
									) : null}
								</p>
							) : null}
							{participants.length > 0 ? (
								<p className="text-[11.5px] text-muted-foreground">
									Showing chats only. Loops, agents and objects have no people to filter by.
								</p>
							) : null}
							{filtersActive ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 px-2 text-[11.5px] max-[1024.02px]:min-h-11"
									onClick={clearFilters}
								>
									Clear filters
								</Button>
							) : null}
						</div>
					) : null}

					{!online && data && !failed ? <OfflineNotice /> : null}
					{pace === 'slow' && data ? <SlowNotice /> : null}
					{partial ? <PartialNotice onRetry={retry} /> : null}

					<output className="sr-only">
						{isFetching && enabled ? 'Searching…' : (countText ?? '')}
						{announcement ? ` ${announcement}` : ''}
					</output>
				</div>
			</div>

			<div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col overflow-y-auto">
				{!enabled ? (
					<SearchIdleState
						workspaceId={workspaceId}
						vocab={vocab}
						onRecentSearchClick={(recent) => {
							setEntry('recent')
							dispatch({
								type: 'hydrate',
								state: {
									text: recent.q,
									types: recent.types,
									statuses: recent.statuses,
									participants: [],
									updated: '',
									sort: 'rel',
								},
							})
							inputRef.current?.focus()
						}}
						onOpenPalette={() => setPaletteOpen(true)}
						onOpenObject={(obj, position, listSize) => {
							trackSearchRowOpened({
								surface: 'search_view',
								entityId: obj.id,
								entityType: searchEntityType('objects', obj.type),
								group: 'objects',
								position,
								hasQuery: false,
								listSize,
								uiVersion: 'v2',
							})
							pushRecentObject(workspaceId, obj.id)
							navigate({
								to: '/$workspaceId/objects/$objectId',
								params: { workspaceId, objectId: obj.id },
							})
						}}
					/>
				) : failed ? (
					<ResultsError offline={!online} onRetry={retry} />
				) : showSkeleton ? (
					<ResultsSkeleton />
				) : showEmpty && data ? (
					<EmptyResults
						explanation={explainEmpty({
							parts,
							vocab,
							updated,
							relaxed: data.relaxed,
						})}
						query={query}
						onApplyWord={(hit) => {
							track({
								dimension: hit.kind,
								action: 'add',
								value: hit.value,
								kind: 'chip',
								via: 'click',
							})
							dispatch({ type: 'applyWord', hit })
						}}
						onClearFilters={clearFilters}
					/>
				) : showList && data ? (
					<>
						<SearchResultList
							rows={data.results}
							sort={sort}
							query={query}
							listboxId={listboxId}
							activeId={activeId}
							dimmed={isPlaceholderData}
							onOpen={openRow}
						/>
						{data.capped ? <CapNotice shown={data.results.length} total={data.total} /> : null}
					</>
				) : null}
			</div>
		</div>
	)
}

function recentLabel(recent: RecentSearch, vocab: Vocabulary): string {
	const pills = [
		...recent.types.map((t) => pillLabel(vocab, 'type', t)),
		...recent.statuses.map((s) => pillLabel(vocab, 'status', s)),
	]
	return [recent.q, ...pills].filter(Boolean).join(' · ')
}

// Nothing typed and no filter chosen: recent searches (words and pills), the
// launcher hint, and the objects opened lately.
function SearchIdleState({
	workspaceId,
	vocab,
	onRecentSearchClick,
	onOpenPalette,
	onOpenObject,
}: {
	workspaceId: string
	vocab: Vocabulary
	onRecentSearchClick: (recent: RecentSearch) => void
	onOpenPalette: () => void
	onOpenObject: (obj: ObjectResponse, position: number, listSize: number) => void
}) {
	const [recentSearches] = useState(() => getRecentSearchEntries(workspaceId))
	const { data: objects = [] } = useObjects(workspaceId)
	const recentObjects = useMemo(() => {
		const byId = new Map(objects.map((o) => [o.id, o]))
		return getRecentObjectIds(workspaceId)
			.map((id) => byId.get(id))
			.filter((o): o is ObjectResponse => Boolean(o))
	}, [objects, workspaceId])

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-6 px-3 py-8 md:px-5">
			<EmptyState
				emphasis="page"
				className="py-0"
				title="Search the workspace"
				description="Chats, loops, agents, people, objects and automations, everything you and the agents have touched, in one result list you can filter."
				action={
					<div className="flex flex-col items-center gap-4">
						{recentSearches.length > 0 ? (
							<div className="flex max-w-[520px] flex-wrap items-center justify-center gap-2">
								<span className="eyebrow">Recent</span>
								{recentSearches.map((recent) => {
									const label = recentLabel(recent, vocab)
									return (
										<button
											key={label}
											type="button"
											onClick={() => onRecentSearchClick(recent)}
											className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-transparent px-3 text-[11.5px] font-semibold text-muted-foreground transition-colors duration-150 hover:border-border-hover hover:text-foreground max-[1024.02px]:min-h-11"
										>
											{label}
										</button>
									)
								})}
							</div>
						) : null}
						<p className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-dashed border-input px-3 py-2 text-[11.5px] text-muted-foreground">
							<span>
								Type a word like “loop” or “done”, then{' '}
								{/* A phone has no Tab key: the suggestion that appears is the tap target. */}
								<span className="max-sm:hidden pointer-coarse:hidden">press Tab</span>
								<span className="hidden max-sm:inline pointer-coarse:inline">
									tap the filter that appears
								</span>{' '}
								to turn it into a filter.
							</span>
							<Button type="button" variant="outline" size="sm" onClick={onOpenPalette}>
								<kbd className="font-mono text-[10px]">{shortcutLabel('K')}</kbd>
							</Button>
						</p>
					</div>
				}
			/>

			{recentObjects.length > 0 ? (
				<section aria-label="Recent objects" className="w-full max-w-[520px]">
					<h2 className="eyebrow pb-2">Recent objects</h2>
					<ul className="flex flex-col">
						{recentObjects.map((obj, index) => (
							<li key={obj.id}>
								<button
									type="button"
									onClick={() => onOpenObject(obj, index + 1, recentObjects.length)}
									className={cn(
										'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent',
										'max-[1024.02px]:min-h-11',
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
