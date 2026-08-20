import { ActorAvatar } from '@/components/shared/actor-avatar'
import { type CreatableType, CreatePicker } from '@/components/shared/create-picker'
import { TypeBadge } from '@/components/shared/type-badge'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useObjects } from '@/hooks/use-objects'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import { type SearchRow, useWorkspaceSearch } from '@/hooks/use-workspace-search'
import {
	type TaxonomyEntityType,
	trackCommandPaletteOpened,
	trackSearchResultOpened,
} from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useCommandPalette } from '@/lib/command-palette-context'
import { highlightText } from '@/lib/search-highlight'
import { pushRecentObject, pushRecentSearch } from '@/lib/search-recents'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import {
	Bot,
	Check,
	CircleDot,
	LayoutGrid,
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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const SEARCH_DEBOUNCE_MS = 300
// The mockup caps the workspace index at six rows so the Commands / Go to
// groups stay reachable without scrolling (mockup 5812).
const MAX_JUMP_ROWS = 6

// v2 restyle — the ⌘K palette (mockup 3234–3259). Four groups: Commands,
// Go to (every primary view), Jump to (the workspace index — chats, loops,
// agents, objects, automations, via the same hook the /search view uses) and
// a terminal Search row. Solid popover surface (no glass, no blur),
// `.eyebrow` mono section labels, a right-aligned kind column and a ↵ chip on
// the highlighted row. `shouldFilter={false}` + server-side ranking keeps the
// ordering identical to /search — one command layer shared across both.

interface PaletteRow {
	id: string
	group: string
	/** Right-aligned kind column: COMMAND / GO TO / the entity's own kind / SEARCH. */
	kind: string
	title: string
	sub?: string
	icon: ReactNode
	run: () => void
	/** Only object rows carry the analytics + recents side effects. */
	object?: ObjectResponse
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

const GROUP_GLYPH: Record<string, LucideIcon> = {
	chats: MessagesSquare,
	loops: RefreshCw,
	agents: Bot,
	automations: Zap,
	objects: Table2,
}

const VIEWS: { title: string; path: (workspaceId: string) => string; icon: LucideIcon }[] = [
	{ title: 'For you', path: (w) => `/${w}`, icon: CircleDot },
	{ title: 'Chats', path: (w) => `/${w}/chats`, icon: MessagesSquare },
	{ title: 'Loops', path: (w) => `/${w}/loops`, icon: RefreshCw },
	{ title: 'Agents', path: (w) => `/${w}/agents`, icon: Bot },
	{ title: 'Objects', path: (w) => `/${w}/objects`, icon: Table2 },
	{ title: 'Marketplace', path: (w) => `/${w}/marketplace`, icon: Store },
	{ title: 'Settings', path: (w) => `/${w}/settings`, icon: Settings },
]

export function CommandPalette() {
	const { open, setOpen } = useCommandPalette()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const panelRef = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLElement | null>(null)

	const [query, setQuery] = useState('')
	const [debouncedQuery, setDebouncedQuery] = useState('')
	const queryRef = useRef(query)
	useEffect(() => {
		queryRef.current = query
	}, [query])
	useEffect(() => {
		const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(t)
	}, [query])

	// The workspace index behind "Jump to" — chats, loops, agents, objects and
	// automations, the same hook the /search view ranks with.
	const { rows: searchRows } = useWorkspaceSearch(workspaceId, { q: debouncedQuery })
	const { data: objects } = useObjects(workspaceId)
	const objectTypes = useAvailableObjectTypes()

	// Mark all read runs the real per-entity mutation over the unread feed —
	// the same call For You's own bulk action makes.
	const { data: unread } = useUnread(workspaceId)
	const markRead = useMarkRead(workspaceId)

	// Mounted only once a create command runs, so the palette's own close
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

	// One `command_palette_opened` per open transition, fired on any route —
	// the success-metric funnel denominator. The /search route fires the same
	// event (surface: 'search_view') on mount, so the See-all footer's
	// navigation to /search produces its palette-open event too.
	const prevOpen = useRef(open)
	useEffect(() => {
		if (open && !prevOpen.current) {
			trackCommandPaletteOpened({ surface: 'command_palette' })
			// Remember what had focus so it can be restored on close — a dialog
			// must never strand focus on a removed element.
			triggerRef.current = document.activeElement as HTMLElement | null
		} else if (!open && prevOpen.current) {
			setQuery('')
			triggerRef.current?.focus?.()
			triggerRef.current = null
		}
		prevOpen.current = open
	}, [open])

	const openObject = useCallback(
		(obj: ObjectResponse) => {
			trackSearchResultOpened({
				entity_id: obj.id,
				entity_type: obj.type as TaxonomyEntityType,
				surface: 'command_palette',
			})
			pushRecentObject(workspaceId, obj.id)
			navigateTo(`/${workspaceId}/objects/${obj.id}`)
		},
		[navigateTo, workspaceId],
	)

	const openSearchRow = useCallback(
		(row: SearchRow) => {
			if (row.object) {
				openObject(row.object)
				return
			}
			navigate({ to: row.to, params: row.params })
			setOpen(false)
		},
		[navigate, openObject, setOpen],
	)

	const trimmedQuery = query.trim()
	const hasQuery = trimmedQuery.length > 0

	const seeAll = useCallback(() => {
		if (!trimmedQuery) return
		pushRecentSearch(workspaceId, trimmedQuery)
		setOpen(false)
		// Typed navigation keeps `q` in the URL's search chunk — same shape the
		// /search route's updateSearch() commits against.
		navigate({
			to: '/$workspaceId/search',
			params: { workspaceId },
			search: { q: trimmedQuery },
		})
	}, [navigate, setOpen, trimmedQuery, workspaceId])

	const openSearchView = useCallback(() => {
		if (trimmedQuery) {
			seeAll()
			return
		}
		setOpen(false)
		navigate({ to: '/$workspaceId/search', params: { workspaceId }, search: { q: '' } })
	}, [navigate, seeAll, setOpen, trimmedQuery, workspaceId])

	// The global key handler is registered once; reading seeAll through a ref
	// keeps it current without re-binding the listener on every keystroke.
	const seeAllRef = useRef(seeAll)
	useEffect(() => {
		seeAllRef.current = seeAll
	}, [seeAll])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setOpen((o) => !o)
			}
			if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
				// ⌘F opens search instead of the browser's find-in-page.
				e.preventDefault()
				setOpen(true)
			}
			if (e.key === 'j' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				openChat()
			}
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				// ⌘↵ — "search everything": hand the typed query to /search
				// instead of running the highlighted item. Advertised in the
				// palette footer (mockup line 3255), so it has to exist.
				if (queryRef.current.trim()) {
					e.preventDefault()
					seeAllRef.current()
				}
			}
			if (e.key === 'Escape') {
				// First Esc clears the query; a second Esc closes the panel.
				if (queryRef.current.trim()) {
					setQuery('')
				} else {
					setOpen(false)
				}
			}
			if (e.key === 'Tab' && panelRef.current) {
				// Trap focus inside the panel while it's open — a dialog must not
				// leak Tab into the page behind it.
				const focusable = panelRef.current.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
				)
				if (focusable.length === 0) return
				const first = focusable[0] as HTMLElement
				const last = focusable[focusable.length - 1] as HTMLElement
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
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [openChat, setOpen])

	const matchesQuery = useCallback(
		(...fields: (string | undefined)[]) => {
			if (!hasQuery) return true
			const needle = trimmedQuery.toLowerCase()
			return fields.some((field) => (field ?? '').toLowerCase().includes(needle))
		},
		[hasQuery, trimmedQuery],
	)

	const commandRows = useMemo(() => {
		const rows: PaletteRow[] = [
			{
				id: 'new-chat',
				group: 'Commands',
				kind: 'COMMAND',
				title: 'New chat',
				sub: 'talk to your agents',
				icon: <GlyphTile icon={MessagesSquare} />,
				run: openChat,
			},
			...objectTypes.map((type) => ({
				id: `new-${type.value}`,
				group: 'Commands',
				kind: 'COMMAND',
				title: `New ${type.label.replace(/s$/, '').toLowerCase()}`,
				sub: 'an agent structures it from what you say',
				icon: <GlyphTile icon={Plus} />,
				run: () => openCreate('object', type.value),
			})),
			{
				id: 'new-loop',
				group: 'Commands',
				kind: 'COMMAND',
				title: 'New loop',
				sub: 'describe it and Maskin wires it',
				icon: <GlyphTile icon={RefreshCw} />,
				run: () => navigateTo(`/${workspaceId}/loops/new`),
			},
			{
				id: 'new-agent',
				group: 'Commands',
				kind: 'COMMAND',
				title: 'New agent',
				sub: 'hire one for an outcome',
				icon: <GlyphTile icon={Sparkles} />,
				run: () => openCreate('agent'),
			},
			{
				id: 'mark-all-read',
				group: 'Commands',
				kind: 'COMMAND',
				title: 'Mark all read',
				sub: 'clear For you',
				icon: <GlyphTile icon={Check} />,
				run: markAllRead,
			},
		]
		return rows.filter((row) => matchesQuery(row.title, row.sub, 'command'))
	}, [matchesQuery, markAllRead, navigateTo, objectTypes, openChat, openCreate, workspaceId])

	const goToRows = useMemo(() => {
		return VIEWS.filter((view) => matchesQuery(view.title, 'go to')).map((view) => ({
			id: `go-${view.title}`,
			group: 'Go to',
			kind: 'GO TO',
			title: view.title,
			icon: <GlyphTile icon={view.icon} />,
			run: () => navigateTo(view.path(workspaceId)),
		}))
	}, [matchesQuery, navigateTo, workspaceId])

	const jumpRows = useMemo(() => {
		if (hasQuery) {
			return searchRows.slice(0, MAX_JUMP_ROWS).map((row) => ({
				id: `jump-${row.group}-${row.id}`,
				group: 'Jump to',
				kind: row.kind,
				title: row.title,
				sub: row.sub || undefined,
				icon: row.object ? (
					<TypeBadge
						type={row.object.type}
						variant="tile"
						className="size-[22px] shrink-0 rounded-md"
					/>
				) : row.group === 'agents' ? (
					<ActorAvatar
						id={row.id}
						name={row.title}
						type="agent"
						className="size-[22px] shrink-0 text-[9px]"
					/>
				) : (
					<GlyphTile icon={GROUP_GLYPH[row.group] ?? LayoutGrid} />
				),
				run: () => openSearchRow(row),
				object: row.object,
			}))
		}
		return (objects ?? []).slice(0, MAX_JUMP_ROWS).map((object) => ({
			id: `jump-object-${object.id}`,
			group: 'Jump to',
			kind: object.type.toUpperCase(),
			title: object.title ?? 'Untitled',
			icon: (
				<TypeBadge type={object.type} variant="tile" className="size-[22px] shrink-0 rounded-md" />
			),
			run: () => openObject(object),
			object,
		}))
	}, [hasQuery, objects, openObject, openSearchRow, searchRows])

	const searchTerminalRow: PaletteRow = {
		id: 'search-everything',
		group: 'Search',
		kind: 'SEARCH',
		title: hasQuery ? `Search everything for “${trimmedQuery}”` : 'Open search',
		sub: hasQuery
			? `${searchRows.length} ${searchRows.length === 1 ? 'match' : 'matches'} · filterable results`
			: 'browse and filter the whole workspace',
		icon: <GlyphTile icon={Search} />,
		run: openSearchView,
	}

	const groups: { label: string; rows: PaletteRow[] }[] = [
		{ label: 'Commands', rows: commandRows },
		{ label: 'Go to', rows: goToRows },
		{ label: 'Jump to', rows: jumpRows },
		{ label: 'Search', rows: [searchTerminalRow] },
	].filter((group) => group.rows.length > 0)

	return (
		<>
			{open && (
				<div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] max-sm:items-end max-sm:pt-0">
					<button
						type="button"
						aria-label="Close palette"
						className="fixed inset-0 bg-foreground/40"
						onClick={() => setOpen(false)}
					/>
					<div
						ref={panelRef}
						// biome-ignore lint/a11y/useSemanticElements: native <dialog> is against project convention (apps/web/CLAUDE.md) — this is the same ARIA div-based modal pattern Radix's own Dialog primitive renders under the hood.
						role="dialog"
						aria-modal="true"
						aria-label="Command palette"
						className="relative w-full max-w-xl mx-auto overflow-hidden border border-border bg-popover text-popover-foreground shadow-xl max-sm:max-h-[92dvh] max-sm:flex max-sm:flex-col max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] sm:w-[calc(100%-2rem)] sm:rounded-2xl"
					>
						<Command
							shouldFilter={false}
							className="w-full max-sm:min-h-0 max-sm:flex-1 max-sm:flex max-sm:flex-col"
						>
							<div className="flex items-center gap-2 border-b border-border px-3.5">
								<Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
								<Command.Input
									value={query}
									onValueChange={setQuery}
									placeholder="Run a command or jump to…"
									className="h-12 w-full bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground outline-none"
									autoFocus
								/>
								<kbd className="hidden shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
									Esc
								</kbd>
							</div>
							<Command.List className="max-h-[360px] overflow-auto p-1.5 max-sm:max-h-none max-sm:min-h-0 max-sm:flex-1">
								<Command.Empty className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">
									{`No command or shortcut matches “${query}”.`}
								</Command.Empty>

								{groups.map((group) => (
									<Command.Group key={group.label}>
										<div className="eyebrow px-2.5 pb-1 pt-2">{group.label}</div>
										{group.rows.map((row) => (
											<Command.Item
												key={row.id}
												value={row.id}
												className={cn(
													'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 cursor-pointer',
													'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
												)}
												onSelect={row.run}
											>
												{row.icon}
												<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
													{highlightText(row.title, hasQuery ? trimmedQuery : '')}
													{row.sub ? (
														<span className="font-normal text-muted-foreground"> — {row.sub}</span>
													) : null}
												</span>
												<span className="shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.05em] text-muted-foreground">
													{row.kind}
												</span>
												<kbd className="hidden shrink-0 rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground group-data-[selected=true]:inline-flex">
													↵
												</kbd>
											</Command.Item>
										))}
									</Command.Group>
								))}
							</Command.List>
							<div className="flex shrink-0 items-center gap-3.5 border-t border-border bg-secondary px-4 py-2 text-[10.5px] text-muted-foreground">
								<span>↑↓ navigate</span>
								<span>↵ run</span>
								<span>⌘↵ search everything</span>
								<span className="ml-auto">esc closes</span>
							</div>
						</Command>
					</div>
				</div>
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
