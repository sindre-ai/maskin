import { type CreatableType, CreatePicker } from '@/components/shared/create-picker'
import { SearchRowTitle } from '@/components/shared/search-row'
import { TypeBadge } from '@/components/shared/type-badge'
import { useActors } from '@/hooks/use-actors'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useLoops } from '@/hooks/use-loops'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObjects } from '@/hooks/use-objects'
import { useSearchFieldHandlers } from '@/hooks/use-search-field-handlers'
import {
	SEARCH_QUERY_DEBOUNCE_MS,
	type SearchQueryInput,
	useDebouncedValue,
	useSearchQuery,
} from '@/hooks/use-search-query'
import { useSearchState } from '@/hooks/use-search-state'
import { useSearchVocabulary } from '@/hooks/use-search-vocabulary'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import { trackCommandPaletteOpened } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { useCommandPalette } from '@/lib/command-palette-context'
import {
	askRowTitle,
	emptyStateText,
	findChiefOfStaff,
	searchRowSub,
	shouldOfferAsk,
} from '@/lib/palette/ask'
import { TRIGGERS_PAGE, matchSettingsPages } from '@/lib/palette/go-to'
import { initialsMatch, matches, rankTitleMatchesFirst } from '@/lib/palette/ranking'
import { buildRecents } from '@/lib/palette/recents'
import { getRecentObjectIds, pushRecentObject } from '@/lib/search-recents'
import {
	searchEntityType,
	trackSearchRowOpened,
	useTrackSettledSearchV2,
} from '@/lib/search-telemetry'
import { navigateToSearchRow } from '@/lib/search/open-row'
import { queryText } from '@/lib/search/parts'
import { shortcutLabel } from '@/lib/search/platform'
import { pushRecentSearchEntry } from '@/lib/search/recents'
import { rowSub, rowTitle } from '@/lib/search/row-display'
import { serializeSearchState, urlStateFromParts } from '@/lib/search/url-state'
import { useWorkspace } from '@/lib/workspace-context'
import type { SearchResultRow } from '@maskin/shared'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
	Bot,
	Check,
	CircleDot,
	type LucideIcon,
	MessagesSquare,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Sparkles,
	Store,
	Table2,
	Zap,
} from 'lucide-react'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'
import { SearchField } from './search-field'
import { RowIcon, orderRows } from './search-results'
import { PartialNotice, ResultsError, ResultsSkeleton } from './search-states'

// The ⌘K launcher behind the search-v2 flag. It is the search page's field in a smaller
// size: the same pills, the same Tab / Backspace behaviour, the same endpoint (asked for
// six rows), so the page and the launcher agree on what a word means and in what order
// results come. Enter on the Search row, or ⌘↵, hands the words and the pills to /search.

const MAX_JUMP_ROWS = 6
const MAX_NEEDS_YOU = 3
const MAX_RECENT = 4

interface PaletteRow {
	id: string
	group: string
	/** Right-aligned kind column: COMMAND / GO TO / the entity's own kind / SEARCH. */
	kind: string
	title: string
	sub?: string
	icon: ReactNode
	run: () => void
}

interface PaletteCommand {
	id: string
	title: string
	sub?: string
	icon: LucideIcon
	run: () => void
}

function GlyphTile({ icon: Icon }: { icon: LucideIcon }) {
	return (
		<span
			aria-hidden="true"
			className="grid size-[22px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
		>
			<Icon className="size-[13px]" />
		</span>
	)
}

const VIEWS: { title: string; path: (workspaceId: string) => string; icon: LucideIcon }[] = [
	{ title: 'For you', path: (w) => `/${w}`, icon: CircleDot },
	{ title: 'Chats', path: (w) => `/${w}/chats`, icon: MessagesSquare },
	{ title: 'Loops', path: (w) => `/${w}/loops`, icon: RefreshCw },
	{ title: 'Agents', path: (w) => `/${w}/agents`, icon: Bot },
	{ title: 'Objects', path: (w) => `/${w}/objects`, icon: Table2 },
	{ title: TRIGGERS_PAGE.title, path: (w) => `/${w}/${TRIGGERS_PAGE.path}`, icon: Zap },
	{ title: 'Marketplace', path: (w) => `/${w}/marketplace`, icon: Store },
	{ title: 'Settings', path: (w) => `/${w}/settings`, icon: Settings },
]

/**
 * Commands and Go to rows match on their title or its initials ("nc" finds New chat), or
 * when the query is the start of the group name ("com" shows every command). Matching the
 * group name or a row's description anywhere would put every command above the result for
 * a short query.
 */
function matchesRow(query: string, title: string, groupName: string): boolean {
	return (
		matches(query, title) ||
		initialsMatch(query, title) ||
		(query.length >= 3 && groupName.startsWith(query.toLowerCase()))
	)
}

/**
 * ⌘F opens the browser's find everywhere except Search and Marketplace, where the
 * page has a field of its own and the key focuses it. Returns true if it took the key.
 */
function focusFindTarget(workspaceId: string, pathname: string): boolean {
	const selector =
		pathname === `/${workspaceId}/search`
			? '[data-search-field="page"]'
			: pathname.startsWith(`/${workspaceId}/marketplace`)
				? 'input[aria-label="Filter marketplace"]'
				: null
	const target = selector ? document.querySelector<HTMLInputElement>(selector) : null
	target?.focus()
	return Boolean(target)
}

export function CommandPaletteV2() {
	const { open, setOpen } = useCommandPalette()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const pathname = useRouterState({ select: (s) => s.location.pathname })
	const objectTypes = useAvailableObjectTypes()
	const typeLabel = useObjectTypeLabel()
	const triggerRef = useRef<HTMLElement | null>(null)

	// Mark all read runs the real per-entity mutation over the unread feed.
	const { data: unread } = useUnread(workspaceId)
	const markRead = useMarkRead(workspaceId)

	// Mounted only once a create command runs, so the launcher's own close
	// doesn't tear the create surface down with it.
	const [createTarget, setCreateTarget] = useState<{
		type: CreatableType
		subtype?: string
	} | null>(null)

	const navigateTo = useCallback(
		(path: string) => {
			navigate({ to: path })
			setOpen(false)
		},
		[navigate, setOpen],
	)
	const openChat = useCallback(() => {
		navigateTo(`/${workspaceId}/chats/new`)
	}, [navigateTo, workspaceId])
	const openCreate = useCallback(
		(type: CreatableType, subtype?: string) => {
			setCreateTarget({ type, subtype })
			setOpen(false)
		},
		[setOpen],
	)

	const markAllRead = useCallback(async () => {
		const items = (unread?.items ?? []).filter(
			(item) => item.unread_count > 0 && (item.latest_event_id ?? 0) > 0,
		)
		setOpen(false)
		if (items.length === 0) {
			toast('Nothing unread')
			return
		}
		const results = await Promise.allSettled(
			items.map((item) =>
				markRead.mutateAsync({
					entityType: item.entity_type,
					entityId: item.entity_id,
					lastEventId: item.latest_event_id as number,
				}),
			),
		)
		const failed = results.filter((r) => r.status === 'rejected').length
		if (failed === 0) {
			toast('All caught up')
		} else {
			toast.error(`${items.length - failed} of ${items.length} marked read`, {
				description: 'Some items failed — try again.',
			})
		}
	}, [markRead, setOpen, unread])

	const commands = useMemo<PaletteCommand[]>(
		() => [
			{
				id: 'new-chat',
				title: 'New chat',
				sub: 'talk to your agents',
				icon: MessagesSquare,
				run: openChat,
			},
			...objectTypes.map((type) => ({
				id: `new-${type.value}`,
				title: `New ${typeLabel(type.value).toLowerCase()}`,
				sub: 'an agent structures it from what you say',
				icon: Plus,
				run: () => openCreate('object', type.value),
			})),
			{
				id: 'new-loop',
				title: 'New loop',
				sub: 'describe it and Maskin wires it',
				icon: RefreshCw,
				run: () => navigateTo(`/${workspaceId}/loops/new`),
			},
			{
				id: 'new-agent',
				title: 'New agent',
				sub: 'hire one for an outcome',
				icon: Sparkles,
				run: () => openCreate('agent'),
			},
			{
				id: 'mark-all-read',
				title: 'Mark all read',
				sub: 'clear For you',
				icon: Check,
				run: markAllRead,
			},
		],
		[markAllRead, navigateTo, objectTypes, openChat, openCreate, typeLabel, workspaceId],
	)

	// One `command_palette_opened` per open transition, on any route. The launcher
	// remembers what had focus (before its own field takes it) so close can give it back.
	const prevOpen = useRef(open)
	useLayoutEffect(() => {
		if (open && !prevOpen.current) {
			triggerRef.current = document.activeElement as HTMLElement | null
		}
		prevOpen.current = open
	}, [open])
	const wasOpen = useRef(false)
	useEffect(() => {
		if (open && !wasOpen.current) {
			trackCommandPaletteOpened({ surface: 'command_palette' })
		} else if (!open && wasOpen.current) {
			triggerRef.current?.focus?.()
			triggerRef.current = null
		}
		wasOpen.current = open
	}, [open])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return
			if (e.key === 'k') {
				e.preventDefault()
				setOpen((o) => !o)
			} else if (e.key === 'f') {
				// Only Search and Marketplace take ⌘F. Anywhere else the browser's find works.
				if (!open && focusFindTarget(workspaceId, pathname)) e.preventDefault()
			} else if (e.key === 'j') {
				e.preventDefault()
				openChat()
			}
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [open, openChat, pathname, setOpen, workspaceId])

	return (
		<>
			{open && (
				<LauncherPanel
					workspaceId={workspaceId}
					commands={commands}
					onClose={() => setOpen(false)}
					navigateTo={navigateTo}
				/>
			)}
			{createTarget && (
				<CreatePicker
					open
					onOpenChange={(next) => {
						if (!next) setCreateTarget(null)
					}}
					defaultType={createTarget.type}
					defaultObjectSubtype={createTarget.subtype}
				/>
			)}
		</>
	)
}

interface PanelProps {
	workspaceId: string
	commands: PaletteCommand[]
	onClose: () => void
	navigateTo: (path: string) => void
}

function LauncherPanel({ workspaceId, commands, onClose, navigateTo }: PanelProps) {
	const navigate = useNavigate()
	const { workspace } = useWorkspace()
	const panelRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const listboxId = useId()
	const vocab = useSearchVocabulary()
	const { state, dispatch, suggestion, types, statuses, query } = useSearchState(vocab)
	const { parts } = state
	const [announcement, setAnnouncement] = useState('')

	useEffect(() => {
		inputRef.current?.focus()
	}, [])

	const { onTextChange, onAcceptSuggestion, onBackspaceToWord, onRemovePill } =
		useSearchFieldHandlers({
			surface: 'command_palette',
			parts,
			vocab,
			suggestion,
			dispatch,
			inputRef,
		})

	const hasQuery = query !== ''
	const hasPills = parts.pills.length > 0
	const isEmpty = !hasQuery && !hasPills

	// The workspace index behind Jump to: the same endpoint as the page, six rows.
	const debouncedText = useDebouncedValue(parts.text, SEARCH_QUERY_DEBOUNCE_MS)
	const input: SearchQueryInput = {
		text: debouncedText,
		types,
		statuses,
		updated: '',
		sort: 'rel',
		limit: MAX_JUMP_ROWS,
	}
	const search = useSearchQuery(workspaceId, input)
	const { data, isError, isFetching, isPlaceholderData, refetch } = search
	const typedSettled = queryText({ ...parts, text: debouncedText }) === query
	const settled = Boolean(data) && !isPlaceholderData && !isFetching && !isError && typedSettled

	// With nothing typed, the first group is what needs the person: the Needs you status group.
	const needsYou = useSearchQuery(
		workspaceId,
		{
			text: '',
			types: [],
			statuses: ['needs_you'],
			updated: '',
			sort: 'recent',
			limit: MAX_NEEDS_YOU,
		},
		isEmpty,
	)
	const { data: objects } = useObjects(workspaceId)
	// Chats and loops fill the empty-field Recent list; agents give the Ask row its Chief of Staff.
	const { data: chatPages } = useConversationsInfinite(workspaceId, undefined, {
		enabled: isEmpty,
	})
	const { data: loops } = useLoops(workspaceId, { enabled: isEmpty })
	const { data: actors } = useActors(workspaceId)
	const chiefOfStaff = findChiefOfStaff(actors)

	useTrackSettledSearchV2({
		surface: 'command_palette',
		active: typedSettled,
		query: debouncedText,
		types,
		statuses,
		updated: '',
		sort: 'rel',
		entry: 'typed',
		isSettled: settled,
		isPartial: (data?.partial.length ?? 0) > 0,
		total: data?.total ?? 0,
	})

	// Hands the words and the pills to the search page. Enter never makes a pill; this is
	// the only way the typed state leaves the launcher.
	const handOver = () => {
		pushRecentSearchEntry(workspaceId, { q: query, types, statuses })
		onClose()
		navigate({
			to: '/$workspaceId/search',
			params: { workspaceId },
			search: serializeSearchState(urlStateFromParts(parts, state.updated, state.sort)),
		})
	}

	const openResult = (
		row: SearchResultRow,
		position: number,
		listSize: number,
		withQuery: boolean,
	) => {
		trackSearchRowOpened({
			surface: 'command_palette',
			entityId: row.id,
			entityType: searchEntityType(row.group, row.type),
			group: row.group,
			position,
			hasQuery: withQuery,
			listSize,
			uiVersion: 'v2',
		})
		if (withQuery) pushRecentSearchEntry(workspaceId, { q: query, types, statuses })
		if (row.group === 'objects') pushRecentObject(workspaceId, row.id)
		onClose()
		navigateToSearchRow(navigate, workspaceId, row)
	}

	const resultRow = (
		row: SearchResultRow,
		group: string,
		position: number,
		listSize: number,
		withQuery: boolean,
	): PaletteRow => ({
		id: `${group}-${row.group}-${row.id}`,
		group,
		kind: row.type.replace(/_/g, ' ').toUpperCase(),
		title: rowTitle(row),
		sub: rowSub(row),
		icon: <RowIcon row={row} />,
		// A row from the previous answer must not open while the new one is on its way.
		run: () => {
			if (withQuery && !settled) return
			openResult(row, position, listSize, withQuery)
		},
	})

	const failed = isError && !data
	const loading = !isEmpty && !data && !failed

	const { rows, nothingFound } = (() => {
		const groups: { label: string; rows: PaletteRow[] }[] = []

		if (isEmpty) {
			const needs = (needsYou.data?.results ?? []).slice(0, MAX_NEEDS_YOU)
			groups.push({
				label: 'Needs you',
				rows: needs.map((row, index) =>
					resultRow(row, 'Needs you', index + 1, needs.length, false),
				),
			})
			const byId = new Map((objects ?? []).map((o) => [o.id, o]))
			const items = buildRecents({
				objectIds: getRecentObjectIds(workspaceId),
				objects: objects ?? [],
				chats: chatPages?.pages?.flatMap((page) => page.conversations) ?? [],
				loops: loops ?? [],
			})
			groups.push({
				label: 'Recent',
				rows: items.map((item, index) => {
					const track = () =>
						trackSearchRowOpened({
							surface: 'command_palette',
							entityId: item.id,
							entityType: searchEntityType(
								item.kind === 'object' ? 'objects' : item.kind === 'chat' ? 'chats' : 'loops',
								item.type ?? '',
							),
							group: item.kind === 'object' ? 'objects' : item.kind === 'chat' ? 'chats' : 'loops',
							position: index + 1,
							hasQuery: false,
							listSize: items.length,
							uiVersion: 'v2',
						})
					const common = {
						id: `recent-${item.kind}-${item.id}`,
						group: 'Recent',
						kind: (item.type ?? item.kind).toUpperCase(),
						title: item.title,
					}
					if (item.kind === 'object') {
						const object = byId.get(item.id)
						return {
							...common,
							icon: (
								<TypeBadge
									type={object?.type ?? 'task'}
									variant="tile"
									className="size-[22px] shrink-0 rounded-md"
								/>
							),
							run: () => {
								track()
								pushRecentObject(workspaceId, item.id)
								navigateTo(`/${workspaceId}/objects/${item.id}`)
							},
						}
					}
					return {
						...common,
						icon: <GlyphTile icon={item.kind === 'chat' ? MessagesSquare : RefreshCw} />,
						run: () => {
							track()
							navigateTo(`/${workspaceId}/${item.kind === 'chat' ? 'chats' : 'loops'}/${item.id}`)
						},
					}
				}),
			})
		}

		// A pill narrows the search to results, so it hides Commands and Go to.
		if (!hasPills) {
			groups.push({
				label: 'Commands',
				rows: rankTitleMatchesFirst(
					commands.filter((c) => matchesRow(query, c.title, 'command')),
					query,
				).map((c) => ({
					id: c.id,
					group: 'Commands',
					kind: 'COMMAND',
					title: c.title,
					sub: c.sub,
					icon: <GlyphTile icon={c.icon} />,
					run: c.run,
				})),
			})
			const views = rankTitleMatchesFirst(
				VIEWS.filter((view) => matchesRow(query, view.title, 'go to')),
				query,
			).map((view) => ({
				id: `go-${view.title}`,
				group: 'Go to',
				kind: 'GO TO',
				title: view.title,
				icon: <GlyphTile icon={view.icon} />,
				run: () => navigateTo(view.path(workspaceId)),
			}))
			// Typing a settings page name ("keychain") adds a Settings › Keychain row.
			const settingsPages = matchSettingsPages(query, { enterprise: workspace?.enterprise }).map(
				(page) => ({
					id: `go-${page.path}`,
					group: 'Go to',
					kind: 'GO TO',
					title: page.title,
					icon: <GlyphTile icon={Settings} />,
					run: () => navigateTo(`/${workspaceId}/${page.path}`),
				}),
			)
			groups.push({ label: 'Go to', rows: [...views, ...settingsPages] })
		}

		if (!isEmpty) {
			const shown = orderRows(data?.results ?? [], 'rel').slice(0, MAX_JUMP_ROWS)
			groups.push({
				label: 'Jump to',
				rows: shown.map((row, index) =>
					resultRow(row, 'Jump to', index + 1, shown.length, hasQuery),
				),
			})
		}

		const total = data?.total ?? 0
		groups.push({
			label: 'Search',
			rows: [
				{
					id: 'search-everything',
					group: 'Search',
					kind: 'SEARCH',
					title: hasQuery
						? `Search everything for “${query}”`
						: hasPills
							? 'Search with these filters'
							: 'Open search',
					sub: isEmpty
						? 'browse and filter the whole workspace'
						: settled
							? searchRowSub(total)
							: undefined,
					icon: <GlyphTile icon={Search} />,
					run: handOver,
				},
			],
		})
		// Nothing in Commands, Go to or Jump to: the Search row alone would leave the list
		// looking empty, so the launcher says so and offers to ask.
		const nothingFound = !isEmpty && groups.every((g) => g.label === 'Search' || !g.rows.length)
		// The Ask row closes the list for a question or a request. A pill narrows the
		// search to results, so it never shows while one is active.
		if (
			hasQuery &&
			!hasPills &&
			chiefOfStaff &&
			shouldOfferAsk(query, !(nothingFound && settled))
		) {
			groups.push({
				label: 'Ask',
				rows: [
					{
						id: 'ask-chief-of-staff',
						group: 'Ask',
						kind: 'ASK',
						title: askRowTitle(query),
						sub: 'opens a new chat, nothing is sent',
						icon: <GlyphTile icon={Sparkles} />,
						run: () => {
							onClose()
							navigate({
								to: '/$workspaceId/chats/new',
								params: { workspaceId },
								search: { agentId: chiefOfStaff.id, agentName: chiefOfStaff.name, text: query },
							})
						},
					},
				],
			})
		}
		// Jump to stays while its answer is loading or failed, so the state has a place to show.
		return {
			rows: groups.filter(
				(group) => group.rows.length > 0 || (group.label === 'Jump to' && (loading || failed)),
			),
			nothingFound,
		}
	})()

	const flat = rows.flatMap((group) => group.rows)
	const [activeId, setActiveId] = useState('')
	// The highlight follows the top row when it changes (new results arrive), and
	// arrowing down moves it without touching that.
	const firstId = flat[0]?.id ?? ''
	useEffect(() => {
		setActiveId(firstId)
	}, [firstId])
	const activeRow = flat.find((row) => row.id === activeId)
	const domId = (row: PaletteRow) => `${listboxId}-${row.id}`
	const activeDomId = activeRow ? domId(activeRow) : undefined
	useEffect(() => {
		if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView({ block: 'nearest' })
	}, [activeDomId])

	const moveActive = (delta: 1 | -1) => {
		if (flat.length === 0) return
		const index = flat.findIndex((row) => row.id === activeId)
		const next =
			index < 0 ? (delta === 1 ? 0 : flat.length - 1) : (index + delta + flat.length) % flat.length
		setActiveId(flat[next].id)
	}

	// First Esc clears the words, the second clears the pills, the third closes.
	const onEscape = () => {
		if (parts.text) dispatch({ type: 'text', text: '' })
		else if (hasPills) dispatch({ type: 'clearFilters' })
		else onClose()
	}

	const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		// The field handles its own keys (a suggestion's Tab, Esc steps) and says so by
		// preventing the default; only what it left alone is ours.
		if (e.defaultPrevented) return
		if (e.key === 'Escape') {
			onClose()
			return
		}
		if (e.key === 'Tab' && panelRef.current) {
			// Keep Tab inside the panel while it is open.
			const focusable = panelRef.current.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
			)
			if (focusable.length === 0) return
			const first = focusable[0]
			const last = focusable[focusable.length - 1]
			const active = document.activeElement
			if (e.shiftKey && active === first) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && active === last) {
				e.preventDefault()
				first.focus()
			}
		}
	}

	const partial = (data?.partial.length ?? 0) > 0
	const noMatches = nothingFound && settled

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] max-sm:items-end max-sm:pt-0">
			<button
				type="button"
				aria-label="Close palette"
				className="fixed inset-0 bg-foreground/40"
				onClick={onClose}
			/>
			<div
				ref={panelRef}
				// biome-ignore lint/a11y/useSemanticElements: native <dialog> is against project convention (apps/web/CLAUDE.md) — this is the same ARIA div-based modal pattern Radix's own Dialog primitive renders under the hood.
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				onKeyDown={onPanelKeyDown}
				className="relative mx-auto flex w-full max-w-xl flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-xl max-sm:max-h-[92dvh] max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] sm:w-[calc(100%-2rem)] sm:rounded-2xl"
			>
				<div className="flex items-center border-b border-border">
					<SearchField
						variant="palette"
						parts={parts}
						vocab={vocab}
						suggestion={suggestion}
						inputRef={inputRef}
						listboxId={listboxId}
						activeOptionId={activeDomId}
						listboxOpen
						onTextChange={onTextChange}
						onAcceptSuggestion={onAcceptSuggestion}
						onDismissSuggestion={() => {
							dispatch({ type: 'dismiss' })
							setAnnouncement('Suggestion dismissed')
						}}
						onBackspaceToWord={onBackspaceToWord}
						onRemovePill={onRemovePill}
						onClearText={() => dispatch({ type: 'text', text: '' })}
						onMoveActive={moveActive}
						onOpenActive={() => activeRow?.run()}
						onModEnter={handOver}
						onEscape={onEscape}
					/>
					<kbd className="mr-3.5 hidden shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
						Esc
					</kbd>
				</div>

				{/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search field, the listbox is never tabbed to */}
				<div
					id={listboxId}
					// biome-ignore lint/a11y/useSemanticElements: the launcher's rows are an ARIA listbox that the search field controls (aria-activedescendant); <select> is for form values
					role="listbox"
					aria-label="Commands and results"
					aria-busy={loading || isFetching}
					className="max-h-[360px] min-h-0 flex-1 overflow-auto p-1.5 max-sm:max-h-none"
				>
					{rows.map((group) => (
						<div
							key={group.label}
							// biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role=group; <fieldset> is for form controls
							role="group"
							aria-label={group.label}
							// The previous answer stays on screen, dimmed, while a new one loads.
							className={cn(group.label === 'Jump to' && !settled && data && 'opacity-60')}
						>
							<div aria-hidden="true" className="eyebrow px-2.5 pb-1 pt-2">
								{group.label}
							</div>
							{group.label === 'Jump to' && loading ? <ResultsSkeleton /> : null}
							{group.label === 'Jump to' && failed ? (
								<ResultsError offline={false} onRetry={() => refetch()} />
							) : null}
							{group.rows.map((row) => (
								// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard use goes through the search field (combobox with aria-activedescendant), not through focus on the row
								<div
									key={row.id}
									id={domId(row)}
									// biome-ignore lint/a11y/useSemanticElements: an option of an ARIA listbox that the search field controls; <option> belongs to <select>
									role="option"
									tabIndex={-1}
									aria-selected={row.id === activeId}
									onMouseMove={() => setActiveId(row.id)}
									onClick={row.run}
									className={cn(
										'group flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 max-[1024.02px]:min-h-11',
										row.id === activeId && 'bg-accent text-accent-foreground',
									)}
								>
									{row.icon}
									<SearchRowTitle
										title={row.title}
										sub={row.sub}
										query={hasQuery ? query : ''}
										className="min-w-0 flex-1 font-semibold"
									/>
									<span className="shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.05em] text-muted-foreground">
										{row.kind}
									</span>
									<kbd
										className={cn(
											'hidden shrink-0 rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground',
											row.id === activeId && 'inline-flex',
										)}
									>
										↵
									</kbd>
								</div>
							))}
						</div>
					))}
					{noMatches ? (
						<p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
							{hasPills ? 'No results with these filters.' : emptyStateText(query)}
						</p>
					) : null}
					{partial ? (
						<div className="px-3 py-2">
							<PartialNotice onRetry={() => refetch()} />
						</div>
					) : null}
				</div>

				{/* Keyboard hints mean nothing on a phone or tablet: no footer there. */}
				<div className="flex shrink-0 items-center gap-3.5 border-t border-border bg-secondary px-4 py-2 text-[10.5px] text-muted-foreground max-sm:hidden pointer-coarse:hidden">
					<span>↑↓ navigate</span>
					<span>↵ run</span>
					<span>{shortcutLabel('↵')} search everything</span>
					<span className="ml-auto">esc closes</span>
				</div>

				<output className="sr-only">
					{settled && !isEmpty
						? `${data?.total ?? 0} result${data?.total === 1 ? '' : 's'}`
						: isFetching && !isEmpty
							? 'Searching…'
							: ''}
					{announcement ? ` ${announcement}` : ''}
				</output>
			</div>
		</div>
	)
}
