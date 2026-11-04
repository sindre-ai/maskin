import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useDocumentTitle } from '@/hooks/use-document-title'
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
import { useCommandPalette } from '@/lib/command-palette-context'
import { focusField, usePageSearchShortcut } from '@/lib/page-search-shortcut'
import { pushRecentObject } from '@/lib/search-recents'
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
import { navigateToSearchRow } from '@/lib/search/open-row'
import { hasPill, queryText } from '@/lib/search/parts'
import { pushRecentSearchEntry } from '@/lib/search/recents'
import { parseSearchState, serializeSearchState } from '@/lib/search/url-state'
import { useWorkspace } from '@/lib/workspace-context'
import type { SearchResponse, SearchResultRow } from '@maskin/shared'
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { SortPill, UpdatedPill } from './display-menu'
import { ParticipantMenu } from './participant-menu'
import { ParticipantFilter } from './search-chips'
import { SearchField } from './search-field'
import { FormRow, FormSection, StatusRows, TypeRows } from './search-form'
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
	usePageSearchShortcut(() => focusField(inputRef.current))
	const listboxId = useId()

	// The words and filters this page knows about, from real workspace types.
	const vocab = useSearchVocabulary()

	// Chats, Loops, Agents, People, then the workspace's object types, then Automations.
	const typeOptions = useMemo<TypeOption[]>(
		() => [
			{ key: 'chat', label: 'Chats' },
			{ key: 'loop', label: 'Flows' },
			{ key: 'agent', label: 'Agents' },
			{ key: 'person', label: 'People' },
			...objectTypes
				.filter((t) => t.value !== 'loop')
				.map((t) => ({ key: t.value, label: t.label })),
			{ key: 'automation', label: 'Automations' },
		],
		[objectTypes],
	)

	const urlState = useMemo(() => parseSearchState(search as Record<string, unknown>), [search])
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
	// The page browses: with nothing typed or chosen it lists everything.
	const asked = hasSearchInput(input)
	const result = useSearchQuery(workspaceId, input, true, true)
	const { data, isError, isFetching, isPlaceholderData, refetch } = result

	// The last good answer keeps the chips honest while a request fails or is slow. It
	// remembers the words it answered, so the count line never pairs it with newer words.
	const lastAnswer = useRef<{ data: SearchResponse; query: string } | undefined>(undefined)
	if (data && !isPlaceholderData) lastAnswer.current = { data, query }
	// Nothing asked (idle): the chips are plain filters, with no counts from an earlier search.
	const facets = (data ?? lastAnswer.current?.data)?.facets ?? null

	// Retry restarts the pace clock too, even though the request was already in flight.
	const [retries, setRetries] = useState(0)
	const retry = () => {
		setRetries((n) => n + 1)
		refetch()
	}
	const pace = useRequestPace(isFetching && online, JSON.stringify([input, retries]))

	const settled = Boolean(data) && !isPlaceholderData && !isFetching && !isError
	useTrackSettledSearchV2({
		active: asked,
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
	const staleChips = !data

	// What fills the content area.
	// Failed, offline with nothing to show, or no answer after 10 seconds. The field and chips stay.
	// Offline, the old rows are not an answer to the new words: show the offline block.
	const failed = ((isError || !online) && (!data || isPlaceholderData)) || pace === 'timeout'
	const showSkeleton = !data && !failed && online
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

	const clearGroup = (kind: 'type' | 'status', chips: { key: string; selected: boolean }[]) => {
		for (const chip of chips) if (chip.selected) toggleFilter(kind, chip.key)
	}

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
			{/* The page draws its own title; the nav row keeps the document title. */}
			<PageHeader title="Search" hideTitle />

			<div className="flex w-full flex-col gap-6 pb-10 pt-1">
				<div className="flex flex-col gap-1.5">
					<Button
						variant="ghost"
						size="sm"
						aria-label="Back"
						onClick={goBack}
						className="-ml-2 h-8 w-fit gap-1 px-2 text-[15px] font-medium text-muted-foreground hover:text-foreground max-[1024.02px]:min-h-11"
					>
						<ChevronLeft aria-hidden="true" className="size-4" />
						Back
					</Button>
					<h1 className="page-title">Search</h1>
					<p className="min-h-5 min-w-0 max-w-full truncate text-[15px] text-muted-foreground">
						{showSkeleton ? (
							'Searching…'
						) : countText ? (
							<>
								{countText}
								{countQuery ? (
									<>
										{' for '}
										<strong className="font-semibold text-foreground">“{countQuery}”</strong>
									</>
								) : null}
							</>
						) : null}
					</p>
					{participants.length > 0 ? (
						<p className="text-[11.5px] text-muted-foreground">
							Showing chats only. Flows, agents and items have no people to filter by.
						</p>
					) : null}
					{!online && data && !failed ? <OfflineNotice /> : null}
					{pace === 'slow' && data ? <SlowNotice /> : null}
					{partial ? <PartialNotice onRetry={retry} /> : null}
					<output className="sr-only">
						{isFetching ? 'Searching…' : (countText ?? '')}
						{announcement ? ` ${announcement}` : ''}
					</output>
				</div>

				<FormSection label="Words">
					<FormRow label="Search">
						<div className="relative flex min-w-0 max-w-[55%] flex-1 md:max-w-75">
							<SearchField
								variant="row"
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
					</FormRow>
				</FormSection>

				<FormSection label="Type">
					<TypeRows
						chips={typeChips}
						showCounts
						onToggle={(key) => toggleFilter('type', key)}
						onClear={() => clearGroup('type', typeChips)}
					/>
				</FormSection>

				<FormSection label="Status">
					<StatusRows
						chips={statusChips}
						showCounts
						onToggle={(key) => toggleFilter('status', key)}
						onClear={() => clearGroup('status', statusChips)}
					/>
				</FormSection>

				<FormSection label="Refine">
					{participantOptions ? (
						<FormRow label="Participants">
							<ParticipantFilter
								options={participantOptions}
								selectedIds={participants}
								onToggle={(option) => {
									const index = parts.pills.findIndex(
										(p) => p.kind === 'participant' && p.value === option.id,
									)
									if (index >= 0) onRemovePill(index)
									else onPickParticipant(option, 'click')
								}}
							/>
						</FormRow>
					) : null}
					<FormRow label="Updated">
						<UpdatedPill
							value={updated}
							onChange={(value) => {
								track({
									dimension: 'updated',
									action: value === '' ? 'reset' : 'set',
									value: value || 'any',
									kind: 'display_menu',
									via: 'click',
								})
								dispatch({ type: 'setUpdated', value })
							}}
						/>
					</FormRow>
					<FormRow label="Sort">
						<SortPill
							value={sort}
							onChange={(value) => {
								track({
									dimension: 'sort',
									action: value === 'rel' ? 'reset' : 'set',
									value,
									kind: 'display_menu',
									via: 'click',
								})
								dispatch({ type: 'setSort', value })
							}}
						/>
					</FormRow>
				</FormSection>

				{filtersActive ? (
					<div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="max-[1024.02px]:min-h-11"
							onClick={clearFilters}
						>
							Clear filters
						</Button>
					</div>
				) : null}

				<div className="flex flex-1 flex-col">
					{failed ? (
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
		</div>
	)
}
