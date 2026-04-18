import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { type ActorListItem, type ObjectResponse, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { SindreSelectionAgent, SindreSelectionObject } from '@/lib/sindre-selection'
import { Command } from 'cmdk'
import { Bot, Box, Check } from 'lucide-react'
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

export type SlashKindId = 'agent' | 'object'

export type SlashPickerResult =
	| { kind: 'agent'; ref: SindreSelectionAgent }
	| { kind: 'object'; ref: SindreSelectionObject }

export interface SlashSearchContext {
	workspaceId: string
	signal: AbortSignal
}

export interface SlashKindDef<TItem = unknown> {
	id: SlashKindId
	label: string
	icon: ReactNode
	placeholder: string
	emptyCopy: string
	multi: boolean
	search: (query: string, ctx: SlashSearchContext) => Promise<TItem[]>
	keyOf: (item: TItem) => string
	renderItem: (item: TItem) => { primary: string; secondary?: string | null }
	toResult: (item: TItem) => SlashPickerResult
}

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
	search: async (query, { workspaceId, signal }) => {
		const actors = await api.actors.list(workspaceId)
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

const objectKind: SlashKindDef<ObjectResponse> = {
	id: 'object',
	label: 'Object',
	icon: <Box size={14} aria-hidden />,
	placeholder: 'Search objects…',
	emptyCopy: 'No objects found.',
	multi: true,
	search: async (query, { workspaceId, signal }) => {
		const needle = query.trim()
		const results = needle
			? await api.objects.search(workspaceId, { q: needle, limit: '20' })
			: await api.objects.list(workspaceId, { limit: '20' })
		if (signal.aborted) return []
		return results
	},
	keyOf: (o) => o.id,
	renderItem: (o) => ({ primary: o.title || 'Untitled', secondary: o.type }),
	toResult: (o) => ({ kind: 'object', ref: { id: o.id, title: o.title, type: o.type } }),
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry — each entry carries its own TItem
export const SLASH_KINDS: ReadonlyArray<SlashKindDef<any>> = [agentKind, objectKind]

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface SlashPickerSelection {
	agent?: SindreSelectionAgent | null
	objects?: SindreSelectionObject[]
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
	const activeKind = useMemo(
		() => kinds.find((k) => k.id === activeKindId) ?? null,
		[kinds, activeKindId],
	)

	const [query, setQuery] = useState('')
	const [items, setItems] = useState<unknown[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<Error | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset query/items/error whenever the active kind flips
	useEffect(() => {
		setQuery('')
		setItems([])
		setError(null)
	}, [activeKindId])

	useEffect(() => {
		if (!activeKind) return
		const controller = new AbortController()
		setLoading(true)
		setError(null)
		const timer = setTimeout(() => {
			activeKind
				.search(query, { workspaceId, signal: controller.signal })
				.then((results) => {
					if (controller.signal.aborted) return
					setItems(results)
				})
				.catch((err) => {
					if (controller.signal.aborted) return
					setError(err instanceof Error ? err : new Error('Search failed'))
					setItems([])
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false)
				})
		}, 120)
		return () => {
			controller.abort()
			clearTimeout(timer)
		}
	}, [activeKind, query, workspaceId])

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
	onPick: (item: unknown) => void
}

function ActiveKindList({ kind, items, loading, error, selected, onPick }: ActiveKindListProps) {
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
				const isSelected = isSelectedForKind(kind.id, key, selected)
				return (
					<Command.Item
						key={key}
						value={key}
						onSelect={() => onPick(item)}
						className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
					>
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
	)
}

function isSelectedForKind(
	kindId: SlashKindId,
	key: string,
	selected: SlashPickerSelection | undefined,
): boolean {
	if (!selected) return false
	if (kindId === 'agent') return selected.agent?.id === key
	if (kindId === 'object') return selected.objects?.some((o) => o.id === key) ?? false
	return false
}
