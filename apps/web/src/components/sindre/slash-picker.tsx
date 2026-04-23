import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { type ActorListItem, type NotificationResponse, type ObjectResponse, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import type {
	SindreSelectionAgent,
	SindreSelectionNotification,
	SindreSelectionObject,
} from '@/lib/sindre-selection'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { Command } from 'cmdk'
import { Bell, Bot, Box, Check } from 'lucide-react'
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'

/**
 * `<SlashPicker>` — Popover + cmdk-based picker for the Sindre composer.
 *
 * Driven by a `SLASH_KINDS` registry so adding a new kind (skill, trigger, …)
 * is a one-entry change — define the kind object and append it to the array.
 * Today the registry ships with:
 *   - `agent`  (single-select) — reroutes the next send to that agent
 *   - `object` (multi-select)  — attaches the objects as context
 *
 * The component is fully controlled: callers own the `open` state, the
 * `selected` snapshot (to draw checkmarks for multi-select kinds), and the
 * selection reducer invoked via `onSelect`. The wiring of `/`-in-textarea,
 * dedicated buttons, and the reducer itself lives in task 35; this file only
 * exposes the picker primitive.
 */

export type SlashKindId = 'agent' | 'item'

export type SlashPickerResult =
	| { kind: 'agent'; ref: SindreSelectionAgent }
	| { kind: 'object'; ref: SindreSelectionObject }
	| { kind: 'notification'; ref: SindreSelectionNotification }

/**
 * Discriminated union surfaced by the "item" kind — combines workspace objects
 * (bets, tasks, insights, …) and notifications into a single searchable list
 * so the user picks "context" in one place rather than via two separate kinds.
 */
export type ItemSearchResult =
	| { kind: 'object'; object: ObjectResponse }
	| { kind: 'notification'; notification: NotificationResponse }

export interface SlashSearchContext {
	workspaceId: string
	signal: AbortSignal
	queryClient: QueryClient
}

export interface SlashKindDef<TItem = unknown> {
	id: SlashKindId
	label: string
	icon: ReactNode
	placeholder: string
	emptyCopy: string
	multi: boolean
	search: (query: string, ctx: SlashSearchContext) => Promise<TItem[]>
	/**
	 * Optional pagination. When defined, the picker shows a "Load more" button
	 * after the initial results and concatenates each page into the visible
	 * list. The page size is what `search` / `loadMore` return; the picker
	 * stops showing the button when a page comes back empty.
	 */
	loadMore?: (query: string, ctx: SlashSearchContext, currentItems: TItem[]) => Promise<TItem[]>
	keyOf: (item: TItem) => string
	renderItem: (item: TItem) => {
		primary: string
		secondary?: string | null
		icon?: ReactNode
	}
	toResult: (item: TItem) => SlashPickerResult
}

const OBJECT_PAGE_SIZE = 20

// ---------------------------------------------------------------------------
// Built-in kinds
// ---------------------------------------------------------------------------

const agentKind: SlashKindDef<ActorListItem> = {
	id: 'agent',
	label: 'Agent',
	icon: <Bot size={14} aria-hidden />,
	placeholder: 'Search agents…',
	emptyCopy: 'No agents found.',
	multi: false,
	// Shares the useActors query cache so opening the picker is free when the
	// workspace actors list is already loaded elsewhere (sidebar, agents page).
	search: async (query, { workspaceId, signal, queryClient }) => {
		const actors = await queryClient.ensureQueryData({
			queryKey: queryKeys.actors.all(workspaceId),
			queryFn: () => api.actors.list(workspaceId),
		})
		if (signal.aborted) return []
		const agents = actors.filter((a) => a.type === 'agent')
		const needle = query.trim().toLowerCase()
		const filtered = needle
			? agents.filter((a) => (a.name ?? '').toLowerCase().includes(needle))
			: agents
		return filtered.slice(0, 20)
	},
	keyOf: (a) => a.id,
	renderItem: (a) => ({ primary: a.name || 'Unnamed agent', secondary: a.email }),
	toResult: (a) => ({ kind: 'agent', ref: { id: a.id, name: a.name } }),
}

const itemKind: SlashKindDef<ItemSearchResult> = {
	id: 'item',
	label: 'Item',
	icon: <Box size={14} aria-hidden />,
	placeholder: 'Search items…',
	emptyCopy: 'No items found.',
	multi: true,
	// Fetch objects + notifications in parallel and show notifications first
	// so the freshest signal is easiest to grab; objects fill the rest of the
	// page. Pagination only walks the object list — notifications are small
	// enough that a single page is typically the whole set.
	search: async (query, { workspaceId, signal }) => {
		const [objects, notifications] = await Promise.all([
			fetchObjectPage(workspaceId, query, 0),
			fetchNotificationPage(workspaceId, query),
		])
		if (signal.aborted) return []
		return [...notifications.map(notificationItem), ...objects.map(objectItem)]
	},
	loadMore: async (query, { workspaceId, signal }, currentItems) => {
		const currentObjects = currentItems.filter((i) => i.kind === 'object').length
		const nextObjects = await fetchObjectPage(workspaceId, query, currentObjects)
		if (signal.aborted) return []
		return nextObjects.map(objectItem)
	},
	keyOf: (item) => `${item.kind}:${item.kind === 'object' ? item.object.id : item.notification.id}`,
	renderItem: (item) => {
		if (item.kind === 'object') {
			return {
				primary: item.object.title || 'Untitled',
				secondary: item.object.type,
				icon: <Box size={12} aria-hidden />,
			}
		}
		return {
			primary: item.notification.title || 'Untitled notification',
			secondary: 'notification',
			icon: <Bell size={12} aria-hidden />,
		}
	},
	toResult: (item) => {
		if (item.kind === 'object') {
			return {
				kind: 'object',
				ref: { id: item.object.id, title: item.object.title, type: item.object.type },
			}
		}
		return {
			kind: 'notification',
			ref: { id: item.notification.id, title: item.notification.title },
		}
	},
}

function objectItem(object: ObjectResponse): ItemSearchResult {
	return { kind: 'object', object }
}

function notificationItem(notification: NotificationResponse): ItemSearchResult {
	return { kind: 'notification', notification }
}

function fetchObjectPage(
	workspaceId: string,
	query: string,
	offset: number,
): Promise<ObjectResponse[]> {
	const needle = query.trim()
	const params: Record<string, string> = {
		limit: String(OBJECT_PAGE_SIZE),
		offset: String(offset),
	}
	if (needle) {
		return api.objects.search(workspaceId, { ...params, q: needle })
	}
	return api.objects.list(workspaceId, params)
}

function fetchNotificationPage(
	workspaceId: string,
	query: string,
): Promise<NotificationResponse[]> {
	const needle = query.trim().toLowerCase()
	return api.notifications.list(workspaceId, { limit: '50' }).then((all) => {
		if (!needle) return all
		return all.filter((n) => (n.title ?? '').toLowerCase().includes(needle))
	})
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry — each entry carries its own TItem
export const SLASH_KINDS: ReadonlyArray<SlashKindDef<any>> = [agentKind, itemKind]

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface SlashPickerSelection {
	agent?: SindreSelectionAgent | null
	objects?: SindreSelectionObject[]
	notifications?: SindreSelectionNotification[]
}

export interface SlashPickerProps {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
	/**
	 * Called each time the user picks an item. Single-select kinds close the
	 * picker afterwards; multi-select kinds stay open so the user can toggle
	 * more items — callers should keep `selected` in sync so checkmarks
	 * reflect current state.
	 */
	onSelect: (result: SlashPickerResult) => void
	selected?: SlashPickerSelection
	/**
	 * Skip the top-level kind menu and open directly in the given kind. Used
	 * by the composer's dedicated "pick agent" / "attach object" buttons so
	 * the user lands straight in a searchable list.
	 */
	initialKindId?: SlashKindId | null
	// biome-ignore lint/suspicious/noExplicitAny: subset of the heterogeneous registry
	kinds?: ReadonlyArray<SlashKindDef<any>>
	/** Optional trigger — rendered as `<PopoverTrigger asChild>{children}</PopoverTrigger>`. */
	children?: ReactNode
	/**
	 * Optional external anchor — rendered as `<PopoverAnchor asChild>{anchor}</PopoverAnchor>`.
	 * Use when the picker is opened via slash-in-textarea or explicit buttons
	 * that are not the same element, and the popover should position against
	 * a fixed reference (e.g. an invisible span pinned to the composer).
	 */
	anchor?: ReactNode
}

export function SlashPicker({
	workspaceId,
	open,
	onOpenChange,
	onSelect,
	selected,
	initialKindId = null,
	kinds = SLASH_KINDS,
	children,
	anchor,
}: SlashPickerProps) {
	const [activeKindId, setActiveKindId] = useState<SlashKindId | null>(initialKindId)

	useEffect(() => {
		if (open) setActiveKindId(initialKindId)
	}, [open, initialKindId])

	const handleOpenChange = useCallback(
		(next: boolean) => {
			onOpenChange(next)
			if (!next) setActiveKindId(initialKindId)
		},
		[onOpenChange, initialKindId],
	)

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			{children ? <PopoverTrigger asChild>{children}</PopoverTrigger> : null}
			{anchor ? <PopoverAnchor asChild>{anchor}</PopoverAnchor> : null}
			<PopoverContent
				className="w-80 p-0"
				align="start"
				sideOffset={6}
				onOpenAutoFocus={(e) => {
					// Let cmdk's Command.Input receive autofocus instead of the Content wrapper.
					e.preventDefault()
				}}
			>
				<SlashPickerBody
					workspaceId={workspaceId}
					kinds={kinds}
					activeKindId={activeKindId}
					onActiveKindChange={setActiveKindId}
					selected={selected}
					onPick={(result, kind) => {
						onSelect(result)
						if (!kind.multi) handleOpenChange(false)
					}}
					onRequestClose={() => handleOpenChange(false)}
				/>
			</PopoverContent>
		</Popover>
	)
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface SlashPickerBodyProps {
	workspaceId: string
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry
	kinds: ReadonlyArray<SlashKindDef<any>>
	activeKindId: SlashKindId | null
	onActiveKindChange: (id: SlashKindId | null) => void
	selected?: SlashPickerSelection
	// biome-ignore lint/suspicious/noExplicitAny: matches registry type
	onPick: (result: SlashPickerResult, kind: SlashKindDef<any>) => void
	onRequestClose: () => void
}

function SlashPickerBody({
	workspaceId,
	kinds,
	activeKindId,
	onActiveKindChange,
	selected,
	onPick,
	onRequestClose,
}: SlashPickerBodyProps) {
	const queryClient = useQueryClient()
	const activeKind = useMemo(
		() => kinds.find((k) => k.id === activeKindId) ?? null,
		[kinds, activeKindId],
	)

	const [query, setQuery] = useState('')
	const [items, setItems] = useState<unknown[]>([])
	const [loading, setLoading] = useState(false)
	const [loadingMore, setLoadingMore] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const [error, setError] = useState<Error | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset query/items/error whenever the active kind flips
	useEffect(() => {
		setQuery('')
		setItems([])
		setError(null)
		setHasMore(false)
	}, [activeKindId])

	useEffect(() => {
		if (!activeKind) return
		const controller = new AbortController()
		setLoading(true)
		setError(null)
		const timer = setTimeout(() => {
			activeKind
				.search(query, { workspaceId, signal: controller.signal, queryClient })
				.then((results) => {
					if (controller.signal.aborted) return
					setItems(results)
					setHasMore(Boolean(activeKind.loadMore) && results.length >= OBJECT_PAGE_SIZE)
				})
				.catch((err) => {
					if (controller.signal.aborted) return
					setError(err instanceof Error ? err : new Error('Search failed'))
					setItems([])
					setHasMore(false)
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false)
				})
		}, 120)
		return () => {
			controller.abort()
			clearTimeout(timer)
		}
	}, [activeKind, query, workspaceId, queryClient])

	const handleLoadMore = useCallback(async () => {
		if (!activeKind?.loadMore || loadingMore) return
		setLoadingMore(true)
		try {
			const next = await activeKind.loadMore(
				query,
				{ workspaceId, signal: new AbortController().signal, queryClient },
				items,
			)
			setItems((prev) => prev.concat(next))
			setHasMore(next.length >= OBJECT_PAGE_SIZE)
		} catch (err) {
			setError(err instanceof Error ? err : new Error('Load more failed'))
		} finally {
			setLoadingMore(false)
		}
	}, [activeKind, items, loadingMore, query, queryClient, workspaceId])

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			if (e.key === 'Escape') {
				e.preventDefault()
				onRequestClose()
				return
			}
			// Empty-query Backspace walks back to the top-level kind menu so the
			// user can re-pick a kind without closing the popover.
			if (e.key === 'Backspace' && query === '' && activeKindId !== null) {
				e.preventDefault()
				onActiveKindChange(null)
			}
		},
		[query, activeKindId, onActiveKindChange, onRequestClose],
	)

	return (
		<Command
			shouldFilter={false}
			className="flex w-full flex-col text-popover-foreground"
			onKeyDown={handleKeyDown}
			label={activeKind ? `Search ${activeKind.label.toLowerCase()}s` : 'Pick a kind'}
		>
			<Command.Input
				value={query}
				onValueChange={setQuery}
				placeholder={activeKind?.placeholder ?? 'Choose a kind…'}
				autoFocus
				className="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none"
			/>
			<Command.List className="max-h-72 overflow-auto p-1">
				{activeKind ? (
					<ActiveKindList
						kind={activeKind}
						items={items}
						loading={loading}
						error={error}
						selected={selected}
						hasMore={hasMore}
						loadingMore={loadingMore}
						onLoadMore={handleLoadMore}
						onPick={(item) => onPick(activeKind.toResult(item), activeKind)}
					/>
				) : (
					<KindMenu kinds={kinds} query={query} onPick={onActiveKindChange} />
				)}
			</Command.List>
		</Command>
	)
}

// ---------------------------------------------------------------------------
// Top-level kind list
// ---------------------------------------------------------------------------

interface KindMenuProps {
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry
	kinds: ReadonlyArray<SlashKindDef<any>>
	query: string
	onPick: (id: SlashKindId) => void
}

function KindMenu({ kinds, query, onPick }: KindMenuProps) {
	const needle = query.trim().toLowerCase()
	const visible = needle ? kinds.filter((k) => k.label.toLowerCase().includes(needle)) : kinds
	if (visible.length === 0) {
		return <div className="px-3 py-3 text-sm text-muted-foreground">No kinds match “{query}”.</div>
	}
	return (
		<Command.Group
			heading="Pick a kind"
			className={cn(
				'px-1 py-1 text-xs text-muted-foreground',
				'[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1',
			)}
		>
			{visible.map((kind) => (
				<Command.Item
					key={kind.id}
					value={kind.id}
					onSelect={() => onPick(kind.id)}
					className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
				>
					<span className="text-muted-foreground">{kind.icon}</span>
					<span className="flex-1 truncate">{kind.label}</span>
					<span className="text-xs text-muted-foreground">{kind.multi ? 'multi' : 'single'}</span>
				</Command.Item>
			))}
		</Command.Group>
	)
}

// ---------------------------------------------------------------------------
// Active-kind search results
// ---------------------------------------------------------------------------

interface ActiveKindListProps {
	// biome-ignore lint/suspicious/noExplicitAny: matches registry type
	kind: SlashKindDef<any>
	items: unknown[]
	loading: boolean
	error: Error | null
	selected?: SlashPickerSelection
	hasMore: boolean
	loadingMore: boolean
	onLoadMore: () => void
	onPick: (item: unknown) => void
}

function ActiveKindList({
	kind,
	items,
	loading,
	error,
	selected,
	hasMore,
	loadingMore,
	onLoadMore,
	onPick,
}: ActiveKindListProps) {
	if (error) {
		return <div className="px-3 py-3 text-sm text-error">{error.message || 'Search failed'}</div>
	}
	if (loading && items.length === 0) {
		return (
			<div className="flex items-center justify-center px-3 py-4 text-sm text-muted-foreground">
				<Spinner />
			</div>
		)
	}
	if (items.length === 0) {
		return <div className="px-3 py-3 text-sm text-muted-foreground">{kind.emptyCopy}</div>
	}
	return (
		<>
			<Command.Group
				heading={kind.label}
				className={cn(
					'px-1 py-1 text-xs text-muted-foreground',
					'[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1',
				)}
			>
				{items.map((item) => {
					const key = kind.keyOf(item)
					const view = kind.renderItem(item)
					const isSelected = isSelectedForItem(kind.id, item, selected, kind.toResult)
					return (
						<Command.Item
							key={key}
							value={key}
							onSelect={() => onPick(item)}
							className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
						>
							{view.icon ? <span className="text-muted-foreground">{view.icon}</span> : null}
							<span className="min-w-0 flex-1">
								<span className="block truncate">{view.primary}</span>
								{view.secondary ? (
									<span className="block truncate text-xs text-muted-foreground">
										{view.secondary}
									</span>
								) : null}
							</span>
							{kind.multi && isSelected ? <Check size={14} aria-label="Selected" /> : null}
						</Command.Item>
					)
				})}
			</Command.Group>
			{hasMore ? (
				<button
					type="button"
					onClick={onLoadMore}
					disabled={loadingMore}
					className="flex w-full items-center justify-center gap-2 rounded px-2 py-2 text-text-secondary text-xs hover:bg-bg-hover disabled:opacity-60"
				>
					{loadingMore ? <Spinner /> : null}
					{loadingMore ? 'Loading…' : 'Load more'}
				</button>
			) : null}
		</>
	)
}

function isSelectedForItem<T>(
	kindId: SlashKindId,
	item: T,
	selected: SlashPickerSelection | undefined,
	toResult: (item: T) => SlashPickerResult,
): boolean {
	if (!selected) return false
	if (kindId === 'agent') {
		const id = (item as unknown as { id: string }).id
		return selected.agent?.id === id
	}
	// Multi-select "item" kind — discriminate by the resolved SlashPickerResult
	// so objects and notifications each hit their own bucket in the selection.
	const resolved = toResult(item)
	if (resolved.kind === 'object') {
		return selected.objects?.some((o) => o.id === resolved.ref.id) ?? false
	}
	if (resolved.kind === 'notification') {
		return selected.notifications?.some((n) => n.id === resolved.ref.id) ?? false
	}
	return false
}
