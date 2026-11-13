import { type CreatableType, CreatePicker } from '@/components/shared/create-picker'
import { useActors } from '@/hooks/use-actors'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useForYou } from '@/hooks/use-for-you'
import { useLoops } from '@/hooks/use-loops'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObjects } from '@/hooks/use-objects'
import { useParticipantMenu, useParticipantOptions } from '@/hooks/use-participant-menu'
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
import { statusLabel } from '@/lib/constants'
import { cardHeadline } from '@/lib/foryou-card-kind'
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
import { highlightText } from '@/lib/search-highlight'
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
import { type Theme, useTheme } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace-context'
import type { SearchResultRow } from '@maskin/shared'
import { useNavigate } from '@tanstack/react-router'
import {
	Bot,
	Check,
	CircleDot,
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
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'
import { ParticipantMenu } from './participant-menu'
import { SearchField } from './search-field'
import { orderRows } from './search-results'
import { PartialNotice, ResultsError, ResultsSkeleton } from './search-states'

// The ⌘K launcher. It is the search page's field in a smaller
// size: the same pills, the same Tab / Backspace behaviour, the same endpoint (asked for
// six rows), so the page and the launcher agree on what a word means and in what order
// results come. Enter on the Search row, or ⌘↵, hands the words and the pills to /search.

const MAX_JUMP_ROWS = 6
// Most rows one group (chats, agents, people) takes of those six, so a name finds all three.
const MAX_JUMP_ROWS_PER_GROUP = 3

const KIND_BY_GROUP: Record<SearchResultRow['group'], string> = {
	objects: 'ITEM',
	loops: 'FLOW',
	chats: 'CHAT',
	agents: 'AGENT',
	people: 'PERSON',
	automations: 'AUTOMATION',
}

/** The kind column: ITEM / FLOW / CHAT as v3 draws it. Rows in Needs you are decisions. */
function resultKind(group: string, row: SearchResultRow): string {
	return group === 'Needs you' && row.group === 'objects' ? 'DECISION' : KIND_BY_GROUP[row.group]
}
const MAX_NEEDS_YOU = 3

interface PaletteRow {
	id: string
	group: string
	/** Right-aligned kind column: COMMAND / GO TO / the entity's own kind / SEARCH. */
	kind: string
	title: string
	sub?: string
	/** Matched text from the item's body, shown as a grey line under the title. */
	snippet?: string
	run: () => void
}

interface PaletteCommand {
	id: string
	title: string
	sub?: string
	/** Extra words that find this row, e.g. the pre-rename name ("loop" for Flows). */
	keywords?: string[]
	run: () => void
}

const VIEWS: {
	title: string
	path: (workspaceId: string) => string
	keywords?: string[]
}[] = [
	{ title: 'For you', path: (w) => `/${w}` },
	{ title: 'Chats', path: (w) => `/${w}/chats` },
	{
		title: 'Flows',
		path: (w) => `/${w}/loops`,
		keywords: ['loop', 'loops'],
	},
	{
		title: 'Items',
		path: (w) => `/${w}/objects`,
		keywords: ['object', 'objects'],
	},
	{ title: 'Agents', path: (w) => `/${w}/agents` },
	{ title: TRIGGERS_PAGE.title, path: (w) => `/${w}/${TRIGGERS_PAGE.path}` },
	{ title: 'Marketplace', path: (w) => `/${w}/marketplace` },
	{ title: 'Settings', path: (w) => `/${w}/settings` },
]

/**
 * Commands and Go to rows match on their title or its initials ("nc" finds New chat), or
 * when the query is the start of the group name ("com" shows every command). Matching the
 * group name or a row's description anywhere would put every command above the result for
 * a short query.
 */
function matchesRow(
	query: string,
	title: string,
	groupName: string,
	keywords: string[] = [],
): boolean {
	return (
		matches(query, title, ...keywords) ||
		initialsMatch(query, title) ||
		(query.length >= 3 && groupName.startsWith(query.toLowerCase()))
	)
}

export function CommandPaletteV2() {
	const { open, setOpen } = useCommandPalette()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const objectTypes = useAvailableObjectTypes()
	const typeLabel = useObjectTypeLabel()
	const triggerRef = useRef<HTMLElement | null>(null)
	const { theme, resolvedTheme, setTheme } = useTheme()

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
				run: openChat,
			},
			...objectTypes.map((type) => ({
				id: `new-${type.value}`,
				title: `New ${typeLabel(type.value).toLowerCase()}`,
				sub: 'an agent structures it from what you say',
				run: () => openCreate('object', type.value),
			})),
			{
				id: 'new-loop',
				title: 'New flow',
				keywords: ['loop', 'new loop'],
				sub: 'describe it and Maskin wires it',
				run: () => navigateTo(`/${workspaceId}/loops/new`),
			},
			{
				id: 'new-agent',
				title: 'New agent',
				sub: 'hire one for an outcome',
				run: () => openCreate('agent'),
			},
			{
				id: 'mark-all-read',
				title: 'Mark all read',
				sub: 'clear For you',
				run: markAllRead,
			},
		],
		[markAllRead, navigateTo, objectTypes, openChat, openCreate, typeLabel, workspaceId],
	)

	// The Settings group: what a person changes without leaving the page. Only the dark-mode
	// toggle shows before anything is typed; typing a word finds the rest.
	const settingsCommands = useMemo<PaletteCommand[]>(() => {
		const dark = resolvedTheme === 'dark'
		const pick = (next: Theme, message: string) => () => {
			setTheme(next)
			setOpen(false)
			toast(message)
		}
		return [
			{
				id: 'setting-dark-mode',
				title: dark ? 'Turn off dark mode' : 'Turn on dark mode',
				sub: `Currently ${dark ? 'dark' : 'light'}${theme === 'system' ? ' (system)' : ''}`,
				keywords: ['theme', 'appearance', 'light', 'dark', 'toggle'],
				run: pick(dark ? 'light' : 'dark', dark ? 'Light mode on' : 'Dark mode on'),
			},
			{
				id: 'setting-theme-light',
				title: 'Theme: Light',
				sub: theme === 'light' ? 'Current' : undefined,
				keywords: ['appearance'],
				run: pick('light', 'Theme set to Light'),
			},
			{
				id: 'setting-theme-dark',
				title: 'Theme: Dark',
				sub: theme === 'dark' ? 'Current' : undefined,
				keywords: ['appearance'],
				run: pick('dark', 'Theme set to Dark'),
			},
			{
				id: 'setting-theme-system',
				title: 'Theme: System',
				sub: theme === 'system' ? 'Current' : 'Follow your device',
				keywords: ['appearance'],
				run: pick('system', 'Theme follows your device'),
			},
			{
				id: 'setting-open-settings',
				title: 'Open settings',
				sub: 'General, members, billing',
				keywords: ['preferences'],
				run: () => navigateTo(`/${workspaceId}/settings`),
			},
		]
	}, [navigateTo, resolvedTheme, setOpen, setTheme, theme, workspaceId])

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
			} else if (e.key === 'j') {
				e.preventDefault()
				openChat()
			}
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [openChat, setOpen])

	return (
		<>
			{open && (
				<LauncherPanel
					workspaceId={workspaceId}
					commands={commands}
					settingsCommands={settingsCommands}
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
	settingsCommands: PaletteCommand[]
	onClose: () => void
	navigateTo: (path: string) => void
}

function LauncherPanel({
	workspaceId,
	commands,
	settingsCommands,
	onClose,
	navigateTo,
}: PanelProps) {
	const navigate = useNavigate()
	const { workspace } = useWorkspace()
	const typeLabel = useObjectTypeLabel()
	const panelRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const listboxId = useId()
	const vocab = useSearchVocabulary()
	const { state, dispatch, suggestion, types, statuses, participants, query } =
		useSearchState(vocab)
	const { parts } = state
	const [announcement, setAnnouncement] = useState('')

	useEffect(() => {
		inputRef.current?.focus()
	}, [])

	const { onTextChange, onAcceptSuggestion, onBackspaceToWord, onRemovePill, onPickParticipant } =
		useSearchFieldHandlers({
			surface: 'command_palette',
			parts,
			vocab,
			suggestion,
			dispatch,
			inputRef,
		})
	const participantOptions = useParticipantOptions(vocab)
	const menu = useParticipantMenu({
		parts,
		options: participantOptions,
		onPick: onPickParticipant,
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
		participants,
		updated: '',
		sort: 'rel',
		limit: MAX_JUMP_ROWS,
		perGroup: MAX_JUMP_ROWS_PER_GROUP,
	}
	const search = useSearchQuery(workspaceId, input)
	const { data, isError, isFetching, isPlaceholderData, refetch } = search
	const typedSettled = queryText({ ...parts, text: debouncedText }) === query
	const settled = Boolean(data) && !isPlaceholderData && !isFetching && !isError && typedSettled

	// With nothing typed, the first group is what needs the person: the For you decisions, then
	// anything else in the Needs you status group.
	const { data: forYou } = useForYou(workspaceId)
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
		kind: resultKind(group, row),
		title: rowTitle(row),
		sub: rowSub(row),
		snippet: row.snippet ?? undefined,
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
			const decisionRows: PaletteRow[] = (forYou?.items ?? []).map((item) => ({
				id: `needs-you-${item.entity_id}`,
				group: 'Needs you',
				kind: 'DECISION',
				title: item.object?.title?.trim() || cardHeadline(item),
				run: () => {
					onClose()
					navigate({
						to: '/$workspaceId/objects/$objectId',
						params: { workspaceId, objectId: item.entity_id },
					})
				},
			}))
			const seen = new Set((forYou?.items ?? []).map((item) => item.entity_id))
			const statusRows = (needsYou.data?.results ?? [])
				.filter((row) => !seen.has(row.id))
				.map((row) => resultRow(row, 'Needs you', 0, MAX_NEEDS_YOU, false))
			groups.push({
				label: 'Needs you',
				rows: [...decisionRows, ...statusRows].slice(0, MAX_NEEDS_YOU),
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
						kind: item.kind === 'object' ? 'ITEM' : item.kind === 'chat' ? 'CHAT' : 'FLOW',
						title: item.title,
					}
					if (item.kind === 'object') {
						const object = byId.get(item.id)
						return {
							...common,
							sub: object ? `${typeLabel(object.type)} · ${statusLabel(object.status)}` : undefined,
							run: () => {
								track()
								pushRecentObject(workspaceId, item.id)
								navigateTo(`/${workspaceId}/objects/${item.id}`)
							},
						}
					}
					return {
						...common,
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
					commands.filter((c) => matchesRow(query, c.title, 'command', c.keywords)),
					query,
				).map((c) => ({
					id: c.id,
					group: 'Commands',
					kind: 'COMMAND',
					title: c.title,
					sub: c.sub,
					run: c.run,
				})),
			})
			// Before anything is typed only the first Settings row (dark mode) is offered.
			const settingRows = (
				isEmpty
					? settingsCommands.slice(0, 1)
					: rankTitleMatchesFirst(
							settingsCommands.filter((c) => matchesRow(query, c.title, 'settings', c.keywords)),
							query,
						)
			).map((c) => ({
				id: c.id,
				group: 'Settings',
				kind: 'SETTING',
				title: c.title,
				sub: c.sub,
				run: c.run,
			}))
			groups.push({ label: 'Settings', rows: settingRows })
			const views = rankTitleMatchesFirst(
				VIEWS.filter((view) => matchesRow(query, view.title, 'go to', view.keywords)),
				query,
			).map((view) => ({
				id: `go-${view.title}`,
				group: 'Go to',
				kind: 'GO TO',
				title: view.title,
				run: () => navigateTo(view.path(workspaceId)),
			}))
			// Typing a settings page name ("keychain") adds a Settings › Keychain row.
			const settingsPages = matchSettingsPages(query, { enterprise: workspace?.enterprise }).map(
				(page) => ({
					id: `go-${page.path}`,
					group: 'Go to',
					kind: 'GO TO',
					title: page.title,
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
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-22.5 max-sm:items-end max-sm:pt-0">
			<button
				type="button"
				aria-label="Close palette"
				className="fixed inset-0 bg-foreground/45"
				onClick={onClose}
			/>
			<div
				ref={panelRef}
				// biome-ignore lint/a11y/useSemanticElements: native <dialog> is against project convention (apps/web/CLAUDE.md) — this is the same ARIA div-based modal pattern Radix's own Dialog primitive renders under the hood.
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				onKeyDown={onPanelKeyDown}
				className="relative mx-auto flex max-h-140 w-full max-w-150 flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl ring-1 ring-border max-sm:max-h-[92dvh] max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] sm:w-[calc(100%-2rem)] sm:rounded-2xl"
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
						menu={menu}
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
					<span className="mr-4.5 hidden shrink-0 text-[13px] text-muted-foreground sm:inline">
						Esc
					</span>
				</div>

				{/* The @ menu takes the results' place while it is open; the results stay mounted underneath. */}
				{menu.open ? (
					<ParticipantMenu
						rows={menu.rows}
						activeIndex={menu.activeIndex}
						listboxId={menu.listboxId}
						onPick={menu.pick}
						className="m-1.5 border-0 p-0 shadow-none"
					/>
				) : null}

				{/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search field, the listbox is never tabbed to */}
				<div
					id={listboxId}
					// biome-ignore lint/a11y/useSemanticElements: the launcher's rows are an ARIA listbox that the search field controls (aria-activedescendant); <select> is for form values
					role="listbox"
					aria-label="Commands and results"
					aria-busy={loading || isFetching}
					className={cn(
						'max-h-105 min-h-0 flex-1 overflow-auto p-1.5 max-sm:max-h-none [&_mark]:bg-warning/25 [&_mark]:text-foreground',
						menu.open && 'hidden',
					)}
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
							<div
								aria-hidden="true"
								className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
							>
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
										'group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.75 max-lg:min-h-11 pointer-coarse:min-h-11',
										row.id === activeId && 'bg-secondary',
									)}
								>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-sm font-semibold text-foreground">
											{highlightText(row.title, hasQuery ? query : '')}
										</span>
										{row.sub ? (
											<span className="truncate text-xs font-normal text-muted-foreground">
												{row.sub}
											</span>
										) : null}
										{hasQuery && row.snippet ? (
											<span className="truncate text-xs font-normal text-muted-foreground">
												{highlightText(row.snippet, query)}
											</span>
										) : null}
									</span>
									<span className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">
										{row.kind}
									</span>
									<span
										aria-hidden="true"
										className="w-4 shrink-0 text-center font-mono text-[11px] text-muted-foreground"
									>
										{row.id === activeId ? '↵' : ''}
									</span>
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
				<div className="flex shrink-0 items-center gap-4 border-t border-border bg-secondary px-4 py-2 text-[11.5px] text-muted-foreground max-sm:hidden pointer-coarse:hidden">
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
