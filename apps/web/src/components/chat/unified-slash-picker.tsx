import { Skeleton } from '@/components/shared/loading-skeleton'
import { TypeBadge } from '@/components/shared/type-badge'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackChatSlashPickerError } from '@/lib/analytics'
import { type ObjectResponse, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useQuery } from '@tanstack/react-query'
import { Box, Sparkles } from 'lucide-react'
import {
	type ReactNode,
	forwardRef,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'

/**
 * `<UnifiedChatSlashPicker>` — the v2 `/` picker built for the chat composer.
 *
 * Ships behind the `chat-slash-picker-v2` feature flag; the legacy per-kind
 * `<SlashPicker>` remains the fallback and continues to serve the `+` menu's
 * pre-filtered "Reference an object" / "Mention an agent" entries. This one is
 * bound to the raw `/` in the textarea: it always shows two stacked sections —
 * `Reference` on top (workspace objects via `search_objects`, or the 5 most-
 * recently-updated when the query is empty) and `Create new` beneath (built-in
 * NEWKIND rows Task / Bet / Insight, always present so the picker never
 * dead-ends).
 *
 * NEWKIND label prefixes like `/task ` narrow both sections to that type via
 * the `typeFilter` prop; the composer owns the chip UI (rendered inside
 * `<SelectionChips>`) so the picker stays a pure floating list.
 */

const REFERENCE_LIMIT = 5
const DEBOUNCE_MS = 120

const CREATE_ROWS: { objectType: string; label: string; sub: string }[] = [
	{ objectType: 'task', label: 'Task', sub: 'A piece of work to track through to done' },
	{ objectType: 'bet', label: 'Bet', sub: 'A shaped, time-boxed outcome' },
	{ objectType: 'insight', label: 'Insight', sub: 'A signal from the world worth capturing' },
]

export interface UnifiedSlashSelectReference {
	kind: 'reference'
	object: ObjectResponse
}

export interface UnifiedSlashSelectCreate {
	kind: 'create'
	objectType: string
	seedTitle: string
}

export type UnifiedSlashSelection = UnifiedSlashSelectReference | UnifiedSlashSelectCreate

export interface UnifiedChatSlashPickerProps {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Current text after the `/` — the composer keeps this in sync. */
	query: string
	/**
	 * NEWKIND chip prefix (e.g. `'task'`). When set both sections narrow to
	 * that type. `null` = no chip.
	 */
	typeFilter: string | null
	onSelect: (selection: UnifiedSlashSelection) => void
	/** Anchored positioning target (invisible span pinned to the composer caret). */
	anchor?: ReactNode
	/**
	 * Called back on every debounced search failure so the composer's own
	 * `chat_slash_picker_error` telemetry can slice by whichever surface
	 * triggered the picker. Optional — the picker also fires the event itself.
	 */
	onSearchError?: (err: Error) => void
	/**
	 * Fires whenever the picker's active row changes. The composer forwards
	 * the id onto its textarea's `aria-activedescendant` so screen readers
	 * announce the highlighted option while the composer keeps DOM focus
	 * (spec §Accessibility). `null` when no row is active (empty list).
	 */
	onActiveDescendantChange?: (id: string | null) => void
}

/**
 * Imperative surface exposed to the composer. Focus stays on the textarea
 * (spec §Accessibility), so arrow keys and Enter reach the picker through
 * this handle rather than by bubbling from an anchor the picker Portal is
 * not a DOM ancestor of.
 */
export interface UnifiedChatSlashPickerHandle {
	/** Move the active row by +1 (ArrowDown) or -1 (ArrowUp). No-op if empty. */
	moveActive: (delta: number) => void
	/** Fire `onSelect` for the currently active row. No-op if empty. */
	selectActive: () => void
}

export const UnifiedChatSlashPicker = forwardRef<
	UnifiedChatSlashPickerHandle,
	UnifiedChatSlashPickerProps
>(function UnifiedChatSlashPicker(
	{
		workspaceId,
		open,
		onOpenChange,
		query,
		typeFilter,
		onSelect,
		anchor,
		onSearchError,
		onActiveDescendantChange,
	},
	ref,
) {
	const isMobile = useIsMobile()

	// 120ms debounce so keystrokes don't fan out into a search-per-char.
	// `debouncedQuery` is the value the search hook keys off.
	const [debouncedQuery, setDebouncedQuery] = useState(query.trim())
	useEffect(() => {
		const trimmed = query.trim()
		const timer = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [query])

	const referenceQuery = useReferenceSearch({
		workspaceId,
		query: debouncedQuery,
		typeFilter,
		enabled: open,
		onError: onSearchError,
	})

	// A chip narrows the create section to its type; without a chip every
	// built-in NEWKIND row is offered so the picker never dead-ends.
	const createRows = useMemo(
		() => (typeFilter ? CREATE_ROWS.filter((row) => row.objectType === typeFilter) : CREATE_ROWS),
		[typeFilter],
	)

	// Flat row list drives the composer's keyboard nav (ArrowDown / ArrowUp /
	// Enter reach us via `useImperativeHandle` — see `UnifiedChatSlashPickerHandle`).
	// References first, then create rows; skeletons/error/empty visuals are not
	// focusable rows.
	const references = referenceQuery.data ?? []
	const trimmedQuery = query.trim()
	const rows = useMemo<UnifiedSlashSelection[]>(() => {
		const refRows: UnifiedSlashSelection[] = references.map((object) => ({
			kind: 'reference',
			object,
		}))
		const createRowsSelections: UnifiedSlashSelection[] = createRows.map((row) => ({
			kind: 'create',
			objectType: row.objectType,
			seedTitle: trimmedQuery,
		}))
		return [...refRows, ...createRowsSelections]
	}, [references, createRows, trimmedQuery])

	const [activeIndex, setActiveIndex] = useState(0)
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset when the visible row list changes
	useEffect(() => {
		// Snap the active row to the first reference (or create row when there
		// are no references) whenever the visible row list changes underneath.
		setActiveIndex(0)
	}, [rows])

	const listboxId = useId()
	const activeRow = rows[activeIndex]
	const activeDescendantId = activeRow ? rowElementId(listboxId, activeIndex) : null

	// Notify the composer whenever the active descendant changes so it can keep
	// the textarea's `aria-activedescendant` in sync. Also send null on close
	// so the attribute clears when the picker isn't showing.
	useEffect(() => {
		if (!onActiveDescendantChange) return
		onActiveDescendantChange(open ? activeDescendantId : null)
	}, [activeDescendantId, open, onActiveDescendantChange])

	// Latest-ref pattern lets the imperative handle read stable state without
	// re-creating the handle on every keystroke (React re-registers a fresh
	// `useImperativeHandle` on every render, which is fine for the composer's
	// own ref usage but noisy in refactors).
	const rowsRef = useRef(rows)
	rowsRef.current = rows
	const activeIndexRef = useRef(activeIndex)
	activeIndexRef.current = activeIndex
	const onSelectRef = useRef(onSelect)
	onSelectRef.current = onSelect

	useImperativeHandle(
		ref,
		() => ({
			moveActive: (delta: number) => {
				const total = rowsRef.current.length
				if (total === 0) return
				setActiveIndex((prev) => Math.max(0, Math.min(total - 1, prev + delta)))
			},
			selectActive: () => {
				const target = rowsRef.current[activeIndexRef.current]
				if (target) onSelectRef.current(target)
			},
		}),
		[],
	)

	const body = (
		<UnifiedPickerBody
			listboxId={listboxId}
			activeDescendantId={activeDescendantId}
			query={query}
			typeFilter={typeFilter}
			references={references}
			loading={referenceQuery.isFetching && !referenceQuery.data}
			error={referenceQuery.error ?? null}
			onRetry={() => referenceQuery.refetch()}
			createRows={createRows}
			activeIndex={activeIndex}
			setActiveIndex={setActiveIndex}
			onSelect={onSelect}
			onRequestClose={() => onOpenChange(false)}
		/>
	)

	if (isMobile) {
		return (
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="bottom"
					className="max-h-[75vh] rounded-t-2xl border-t p-0"
					aria-describedby={undefined}
				>
					<SheetHeader className="sr-only">
						<SheetTitle>Reference or create</SheetTitle>
					</SheetHeader>
					<div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border" aria-hidden />
					{body}
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{anchor ? <PopoverAnchor asChild>{anchor}</PopoverAnchor> : null}
			<PopoverContent
				className="w-[380px] p-0"
				align="start"
				side="top"
				sideOffset={8}
				// Composer input must keep DOM focus — the picker is anchored, not modal.
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				{body}
			</PopoverContent>
		</Popover>
	)
})

interface UnifiedPickerBodyProps {
	listboxId: string
	activeDescendantId: string | null
	query: string
	typeFilter: string | null
	references: ObjectResponse[]
	loading: boolean
	error: Error | null
	onRetry: () => void
	createRows: { objectType: string; label: string; sub: string }[]
	activeIndex: number
	setActiveIndex: (updater: number | ((prev: number) => number)) => void
	onSelect: (selection: UnifiedSlashSelection) => void
	onRequestClose: () => void
}

function UnifiedPickerBody({
	listboxId,
	activeDescendantId,
	query,
	typeFilter,
	references,
	loading,
	error,
	onRetry,
	createRows,
	activeIndex,
	setActiveIndex,
	onSelect,
	onRequestClose,
}: UnifiedPickerBodyProps) {
	const trimmedQuery = query.trim()
	const hasQuery = trimmedQuery.length > 0

	const referenceHeading = referenceHeadingCopy(hasQuery, references.length, typeFilter, query)
	const createHeading = createHeadingCopy(hasQuery, typeFilter, query)
	const footer = footerCopy(references.length, createRows.length)

	return (
		// Custom listbox (per spec §Accessibility): the composer keeps DOM focus
		// (`aria-activedescendant` rides on the textarea, forwarded via
		// `onActiveDescendantChange`). This role stays on the panel so screen
		// readers still announce it as a listbox; arrow keys and Enter reach the
		// active row through the outer component's imperative handle, not by
		// bubbling from a Popover portal that isn't a DOM ancestor of the
		// textarea. `Escape` closes on mouse focus (touch bottom-sheet path);
		// on desktop the composer intercepts Escape before it can reach here.
		// biome-ignore lint/a11y/useSemanticElements: floating listbox, focus stays on the composer textarea
		<div
			role="listbox"
			id={listboxId}
			aria-label="Reference or create"
			aria-activedescendant={activeDescendantId ?? undefined}
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.preventDefault()
					onRequestClose()
				}
			}}
			className="flex flex-col text-popover-foreground"
		>
			<div className="max-h-[420px] overflow-auto p-1">
				{/* Reference section — search results, recent, skeletons, or error. */}
				<Section heading={referenceHeading} sub={hasQuery || typeFilter ? null : 'recent'}>
					{error ? (
						<ErrorState message={error.message || "Couldn't search"} onRetry={onRetry} />
					) : loading ? (
						<ReferenceSkeletons />
					) : references.length === 0 ? (
						<EmptyReferenceState hasQuery={hasQuery} query={query} />
					) : (
						references.map((object, refIndex) => {
							const flatIndex = refIndex
							const selected = flatIndex === activeIndex
							return (
								<ReferenceRow
									key={object.id}
									id={rowElementId(listboxId, flatIndex)}
									object={object}
									selected={selected}
									onMouseEnter={() => setActiveIndex(flatIndex)}
									onClick={() => onSelect({ kind: 'reference', object })}
								/>
							)
						})
					)}
				</Section>
				{/* Create-new section — always rendered so the picker never dead-ends. */}
				<Section heading={createHeading}>
					{createRows.map((row, createIndex) => {
						const flatIndex = references.length + createIndex
						const selected = flatIndex === activeIndex
						return (
							<CreateRow
								key={row.objectType}
								id={rowElementId(listboxId, flatIndex)}
								label={hasQuery ? `Create ${row.objectType} "${query}"` : row.label}
								sub={hasQuery ? null : row.sub}
								selected={selected}
								onMouseEnter={() => setActiveIndex(flatIndex)}
								onClick={() =>
									onSelect({ kind: 'create', objectType: row.objectType, seedTitle: trimmedQuery })
								}
							/>
						)
					})}
				</Section>
			</div>
			<div
				className="flex items-center justify-between gap-2 border-border border-t px-3 py-2 text-[10.5px] text-muted-foreground"
				aria-hidden
			>
				<span className="truncate">{footer}</span>
			</div>
		</div>
	)
}

function rowElementId(listboxId: string, index: number) {
	return `${listboxId}-row-${index}`
}

function Section({
	heading,
	sub,
	children,
}: {
	heading: string
	sub?: string | null
	children: ReactNode
}) {
	return (
		<div className="mb-1 last:mb-0">
			<div className="flex items-center gap-1 px-2 py-1">
				<span className="eyebrow">{heading}</span>
				{sub ? <span className="eyebrow text-muted-foreground/80">· {sub}</span> : null}
			</div>
			<div className="flex flex-col">{children}</div>
		</div>
	)
}

interface ReferenceRowProps {
	id: string
	object: ObjectResponse
	selected: boolean
	onClick: () => void
	onMouseEnter: () => void
}

function ReferenceRow({ id, object, selected, onClick, onMouseEnter }: ReferenceRowProps) {
	// Rendered inside a custom-listbox parent (see comment on the container);
	// keeping it as a button lets it stay tab-reachable while carrying the ARIA
	// option semantics screen-readers announce. Native `<option>` isn't tab-
	// reachable inside a floating listbox that isn't a `<select>`.
	return (
		<button
			type="button"
			// biome-ignore lint/a11y/useSemanticElements: option inside custom listbox — native <option> isn't focusable in a floating panel
			role="option"
			aria-selected={selected}
			id={id}
			onClick={onClick}
			onMouseEnter={onMouseEnter}
			className={cn(
				'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground',
				selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
			)}
		>
			<TypeBadge type={object.type} variant="dot" />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{object.title || 'Untitled'}</span>
				<span className="block truncate text-[11px] text-muted-foreground">{object.type}</span>
			</span>
		</button>
	)
}

interface CreateRowProps {
	id: string
	label: string
	sub: string | null
	selected: boolean
	onClick: () => void
	onMouseEnter: () => void
}

function CreateRow({ id, label, sub, selected, onClick, onMouseEnter }: CreateRowProps) {
	return (
		<button
			type="button"
			// biome-ignore lint/a11y/useSemanticElements: option inside custom listbox — native <option> isn't focusable in a floating panel
			role="option"
			aria-selected={selected}
			id={id}
			onClick={onClick}
			onMouseEnter={onMouseEnter}
			className={cn(
				'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground',
				selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
			)}
		>
			<Sparkles size={14} aria-hidden className="text-muted-foreground" />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-semibold">{label}</span>
				{sub ? (
					<span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
				) : null}
			</span>
		</button>
	)
}

function ReferenceSkeletons() {
	return (
		<div aria-label="Loading references" aria-live="polite" className="flex flex-col gap-1 px-2">
			{[0, 1, 2].map((n) => (
				<div key={n} className="flex items-center gap-2 rounded py-1.5">
					<Skeleton className="h-2 w-2 rounded-full" />
					<Skeleton className="h-3 w-40" />
				</div>
			))}
		</div>
	)
}

function EmptyReferenceState({ hasQuery, query }: { hasQuery: boolean; query: string }) {
	if (hasQuery) {
		return (
			<div className="px-3 py-3 text-center text-muted-foreground text-sm">
				Nothing in this workspace matches "{query}".
			</div>
		)
	}
	return (
		<div className="px-3 py-3 text-center text-muted-foreground text-sm">
			<Box size={12} aria-hidden className="mx-auto mb-1 opacity-60" />
			<span>No recent objects yet.</span>
		</div>
	)
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<div
			role="alert"
			className="flex items-center justify-between gap-2 rounded px-2 py-2 text-error text-sm"
		>
			<span className="min-w-0 truncate">Couldn't search — try again</span>
			<button
				type="button"
				onClick={onRetry}
				className="rounded border border-border px-2 py-0.5 text-foreground text-xs hover:bg-accent"
			>
				Retry
			</button>
			<span className="sr-only">{message}</span>
		</div>
	)
}

function referenceHeadingCopy(
	hasQuery: boolean,
	matchCount: number,
	typeFilter: string | null,
	query: string,
): string {
	if (typeFilter) {
		if (!hasQuery) return `Reference ${typeFilter}s`
		return matchCount === 0
			? `Reference ${typeFilter}s — no matches for "${query}"`
			: `Reference ${typeFilter}s — matches for "${query}"`
	}
	if (!hasQuery) return 'Reference'
	return matchCount === 0
		? `Reference — no matches for "${query}"`
		: `Reference — matches for "${query}"`
}

function createHeadingCopy(hasQuery: boolean, typeFilter: string | null, query: string): string {
	if (typeFilter) return `Create ${typeFilter}`
	if (!hasQuery) return 'Create new'
	return `Create new — "${query}"`
}

function footerCopy(recentCount: number, createCount: number): string {
	return `↑↓ navigate · ↵ select · esc close · ${recentCount} recent · ${createCount} create`
}

// ---------------------------------------------------------------------------
// Reference search hook
// ---------------------------------------------------------------------------

function useReferenceSearch({
	workspaceId,
	query,
	typeFilter,
	enabled,
	onError,
}: {
	workspaceId: string
	query: string
	typeFilter: string | null
	enabled: boolean
	onError?: (err: Error) => void
}) {
	// `keepPreviousData` would be nice but pulls tanstack-query v5's own tree —
	// this manual latching keeps the last successful page visible while a new
	// query is in flight, matching the "search updates live" AC without a
	// content flash.
	const previousRef = useRef<ObjectResponse[] | null>(null)
	const query$ = useQuery({
		queryKey: ['unified-slash-picker', workspaceId, query, typeFilter ?? null],
		queryFn: async () => {
			const params: Record<string, string> = {
				limit: String(REFERENCE_LIMIT),
				include_archived: 'false',
			}
			// Server-side type filter — spec §Referenceable object types names
			// `search_objects` as the API and `list_objects` as an acceptable
			// empty-query fallback for the most-recently-updated slice.
			if (typeFilter) params.type = typeFilter
			let results: ObjectResponse[]
			if (query.length > 0) {
				results = await api.objects.search(workspaceId, { ...params, q: query })
			} else {
				results = await api.objects.list(workspaceId, params)
			}
			previousRef.current = results
			return results
		},
		enabled,
		staleTime: 15_000,
	})

	// Analytics on failure — fires once per settled failure per query, since
	// tanstack-query cache-keys the search and won't re-run identical inputs.
	useEffect(() => {
		if (query$.error) {
			const err = query$.error instanceof Error ? query$.error : new Error('Search failed')
			trackChatSlashPickerError({ message: err.message })
			onError?.(err)
		}
	}, [query$.error, onError])

	return {
		data: query$.data ?? previousRef.current ?? undefined,
		error: query$.error instanceof Error ? query$.error : (query$.error ?? null),
		isFetching: query$.isFetching,
		refetch: () => query$.refetch(),
	}
}
