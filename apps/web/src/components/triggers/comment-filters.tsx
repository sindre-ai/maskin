import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useActors } from '@/hooks/use-actors'
import { cn } from '@/lib/cn'
import { ChevronDown, X } from 'lucide-react'
import type * as React from 'react'
import { useMemo, useState } from 'react'

// ─── State model ──────────────────────────────────────────────────────────
//
// Sits alongside `SlackFilterState` as a typed intermediate the trigger form
// serialises into the trigger `config.filter` + `config.conditions` shape at
// save time, and deserialises back on load. Kept separate from
// `slackFiltersToConditions` because the field-and-operator shape is different:
// comment filters are field-typed (author is [actor], attention is [N], mentions
// is [actor], on-target-type is [pill]) rather than free-form field/operator/
// value like the existing `ConditionEditor`.
//
// UI spec §5.4 (Product Designer) defines the four rows and the copy verbatim.

export interface CommentFilterState {
	/** Comment author actor id, or null for "Any author". Writes filter.actorId. */
	authorId: string | null
	/**
	 * Attention level 1-5 or null for "any attention". Writes filter.attention.
	 * Copy: "Attention level is · or higher" — matcher ships equality per tech
	 * spec §5.1; the "or higher" phrasing is UI copy the Product Designer keeps
	 * on the pill legend by design (matches every level *equal to* the picked
	 * one; a future condition-based tightening lives outside this PR's scope).
	 */
	attention: 1 | 2 | 3 | 4 | 5 | null
	/** Mentioned actor id, or null for "Anyone or nobody". Writes a `contains` condition on `mentions`. */
	mentionedActorId: string | null
	/**
	 * Target object type: 'bet' | 'task' | 'insight' | 'any'. 'any' means the
	 * `filter.on_target_type` key is not written at all — the matcher then
	 * ignores target-type entirely.
	 */
	onTargetType: 'bet' | 'task' | 'insight' | 'any'
	/** Optional parent event id (Advanced → Reply in thread). */
	replyInThreadEventId: string
}

export const EMPTY_COMMENT_FILTER_STATE: CommentFilterState = {
	authorId: null,
	attention: null,
	mentionedActorId: null,
	onTargetType: 'any',
	replyInThreadEventId: '',
}

const TARGET_TYPE_OPTIONS: {
	value: CommentFilterState['onTargetType']
	label: string
	// A small colored dot inside each pill uses the type-badge palette. `any`
	// picks the neutral muted-foreground token.
	dot: 'bet' | 'task' | 'insight' | 'any'
}[] = [
	{ value: 'bet', label: 'Bet', dot: 'bet' },
	{ value: 'task', label: 'Task', dot: 'task' },
	{ value: 'insight', label: 'Insight', dot: 'insight' },
	{ value: 'any', label: 'Any object', dot: 'any' },
]

const ATTENTION_LEVELS = [1, 2, 3, 4, 5] as const

// ─── Config serialisation ─────────────────────────────────────────────────
//
// A comment-action config looks like:
//   {
//     entity_type: 'object',
//     action: 'commented',
//     filter: {
//       actorId?:            '<uuid>',     // Comment author
//       attention?:          4,             // Attention level (equality — see field comment above)
//       parentEventId?:      702123,        // Reply in thread (Advanced)
//       on_target_type?:     'bet',         // Not written when 'any'
//     },
//     conditions: [
//       { field: 'mentions', operator: 'contains', value: '<actor-uuid>' },  // when mentionedActorId set
//     ],
//   }
//
// The matcher's `buildFilterRoot` in trigger-runner.ts merges `event.actor_id`
// into filterRoot as `actorId` and the target object's `type` as
// `__target_type`, so these unprefixed keys resolve.

const COMMENT_FILTER_KEYS = new Set<string>([
	'actorId',
	'attention',
	'parentEventId',
	'on_target_type',
])

export function commentFilterStateToConfig(state: CommentFilterState): {
	filter?: Record<string, unknown>
	conditions?: { field: string; operator: 'contains'; value: string }[]
} {
	const filter: Record<string, unknown> = {}
	if (state.authorId) filter.actorId = state.authorId
	if (state.attention !== null) filter.attention = state.attention
	if (state.onTargetType !== 'any') filter.on_target_type = state.onTargetType
	const parentEventId = Number.parseInt(state.replyInThreadEventId.trim(), 10)
	if (Number.isFinite(parentEventId) && parentEventId > 0) {
		filter.parentEventId = parentEventId
	}
	const conditions: { field: string; operator: 'contains'; value: string }[] = []
	if (state.mentionedActorId) {
		conditions.push({ field: 'mentions', operator: 'contains', value: state.mentionedActorId })
	}
	return {
		...(Object.keys(filter).length > 0 ? { filter } : {}),
		...(conditions.length > 0 ? { conditions } : {}),
	}
}

export function commentFilterStateFromConfig(
	filter: Record<string, unknown> | undefined,
	conditions: { field: string; operator: string; value?: unknown }[] | undefined,
): CommentFilterState {
	const state: CommentFilterState = { ...EMPTY_COMMENT_FILTER_STATE }
	if (filter && typeof filter === 'object') {
		if (typeof filter.actorId === 'string') state.authorId = filter.actorId
		const rawAttention = filter.attention
		if (
			typeof rawAttention === 'number' &&
			rawAttention >= 1 &&
			rawAttention <= 5 &&
			Number.isInteger(rawAttention)
		) {
			state.attention = rawAttention as CommentFilterState['attention']
		}
		const onTargetType = filter.on_target_type
		if (
			typeof onTargetType === 'string' &&
			(onTargetType === 'bet' || onTargetType === 'task' || onTargetType === 'insight')
		) {
			state.onTargetType = onTargetType
		}
		const parentEventId = filter.parentEventId
		if (typeof parentEventId === 'number' && Number.isFinite(parentEventId) && parentEventId > 0) {
			state.replyInThreadEventId = String(parentEventId)
		} else if (typeof parentEventId === 'string' && parentEventId.trim().length > 0) {
			state.replyInThreadEventId = parentEventId.trim()
		}
	}
	if (Array.isArray(conditions)) {
		for (const c of conditions) {
			if (c.field === 'mentions' && c.operator === 'contains' && typeof c.value === 'string') {
				state.mentionedActorId = c.value
				break
			}
		}
	}
	return state
}

/**
 * Returns true for a condition row this component owns (currently: the
 * `mentions contains <actor>` shape). Used by trigger-form to partition
 * conditions between CommentFilters and ConditionEditor so the two editors
 * don't fight over the same rows.
 */
export function isCommentFilterCondition(c: {
	field: string
	operator: string
	value?: unknown
}): boolean {
	return c.field === 'mentions' && c.operator === 'contains' && typeof c.value === 'string'
}

/**
 * True for filter keys this component owns. Exposed for callers that want to
 * strip these keys from a partial config diff — not needed by trigger-form
 * today (the whole `filter` object is rewritten each save), so kept behind the
 * export for symmetry with `isCommentFilterCondition` and future extensibility.
 */
export function isCommentFilterKey(key: string): boolean {
	return COMMENT_FILTER_KEYS.has(key)
}

// ─── Component ────────────────────────────────────────────────────────────

interface CommentFiltersProps {
	workspaceId: string
	value: CommentFilterState
	onChange: (next: CommentFilterState) => void
}

export function CommentFilters({ workspaceId, value, onChange }: CommentFiltersProps) {
	const [advancedOpen, setAdvancedOpen] = useState(value.replyInThreadEventId.length > 0)

	// Reuse the existing workspace-actors query — same one the trigger form
	// already reads for the agent picker, so no extra network request.
	const { data: actors } = useActors(workspaceId, { enabled: true })
	const actorList = useMemo(() => actors ?? [], [actors])
	const actorById = useMemo(() => new Map(actorList.map((a) => [a.id, a])), [actorList])

	return (
		<section aria-labelledby="comment-filters-eyebrow" className="mt-5">
			<h2 id="comment-filters-eyebrow" className="eyebrow">
				COMMENT FILTERS
			</h2>
			<p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
				The trigger fires when a comment matches every filter below. Leave a filter empty to match
				anything for that field.
			</p>
			<div className="mt-2.5 divide-y divide-border rounded-xl border border-border bg-card">
				<CommentFilterRow label="Comment author is" htmlFor="comment-filter-author">
					<ActorAutocomplete
						id="comment-filter-author"
						actors={actorList}
						selectedId={value.authorId}
						placeholder="Any author"
						onChange={(id) => onChange({ ...value, authorId: id })}
					/>
				</CommentFilterRow>
				<CommentFilterRow label="Attention level is" htmlFor="comment-filter-attention">
					<AttentionLevelSelect
						id="comment-filter-attention"
						value={value.attention}
						onChange={(a) => onChange({ ...value, attention: a })}
					/>
				</CommentFilterRow>
				<CommentFilterRow label="Mentions" htmlFor="comment-filter-mentions">
					<ActorAutocomplete
						id="comment-filter-mentions"
						actors={actorList}
						selectedId={value.mentionedActorId}
						placeholder="Anyone or nobody"
						onChange={(id) => onChange({ ...value, mentionedActorId: id })}
					/>
				</CommentFilterRow>
				<CommentFilterRow label="Only on comments on" htmlFor="comment-filter-target-type">
					<TargetTypePills
						id="comment-filter-target-type"
						value={value.onTargetType}
						onChange={(t) => onChange({ ...value, onTargetType: t })}
					/>
				</CommentFilterRow>
			</div>

			<div className="mt-2">
				<button
					type="button"
					onClick={() => setAdvancedOpen(!advancedOpen)}
					aria-expanded={advancedOpen}
					className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
				>
					<ChevronDown
						size={12}
						className={cn(
							'transition-transform duration-200 ease-brand',
							advancedOpen ? 'rotate-180' : 'rotate-0',
						)}
						aria-hidden="true"
					/>
					Advanced
				</button>
				{advancedOpen && (
					<div className="mt-2.5 max-w-[420px]">
						<Label
							htmlFor="comment-filter-reply-in-thread"
							className="text-[10.5px] font-normal text-muted-foreground"
						>
							Reply in thread
						</Label>
						<Input
							id="comment-filter-reply-in-thread"
							value={value.replyInThreadEventId}
							onChange={(e) => onChange({ ...value, replyInThreadEventId: e.target.value })}
							inputMode="numeric"
							placeholder="Event id, e.g. 702123"
							className="mt-1.5 min-h-11 font-mono text-xs sm:min-h-8"
						/>
						<p className="mt-1.5 text-[11px] text-muted-foreground">
							Fires only when the comment&apos;s <strong>parentEventId</strong> equals this event id
							— pins the trigger to a known thread root. Leave empty for any thread.
						</p>
					</div>
				)}
			</div>
		</section>
	)
}

function CommentFilterRow({
	label,
	htmlFor,
	children,
}: {
	label: string
	htmlFor: string
	children: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center">
			<Label
				htmlFor={htmlFor}
				className="w-full text-[11.5px] font-semibold text-muted-foreground sm:w-[168px] sm:flex-shrink-0"
			>
				{label}
			</Label>
			<div className="flex min-w-0 flex-1 items-center">{children}</div>
		</div>
	)
}

// ─── AttentionLevelSelect ─────────────────────────────────────────────────
//
// New pattern per UI spec §Design system reuse. Five 28×28 mono-numeral pills
// with a persistent "or higher" legend. `role="radiogroup"` + `role="radio"` per
// a11y section. Arrow keys move selection, Space/Enter selects.

interface AttentionLevelSelectProps {
	id: string
	value: 1 | 2 | 3 | 4 | 5 | null
	onChange: (next: 1 | 2 | 3 | 4 | 5 | null) => void
}

export function AttentionLevelSelect({ id, value, onChange }: AttentionLevelSelectProps) {
	const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, level: 1 | 2 | 3 | 4 | 5) => {
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault()
			const next = Math.min(5, level + 1) as 1 | 2 | 3 | 4 | 5
			onChange(next)
			document.getElementById(`${id}-${next}`)?.focus()
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault()
			const next = Math.max(1, level - 1) as 1 | 2 | 3 | 4 | 5
			onChange(next)
			document.getElementById(`${id}-${next}`)?.focus()
		} else if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault()
			onChange(value === level ? null : level)
		}
	}

	return (
		<div
			id={id}
			role="radiogroup"
			aria-label="Attention level"
			className="flex flex-wrap items-center gap-2"
		>
			{ATTENTION_LEVELS.map((level) => {
				const selected = value === level
				return (
					<button
						key={level}
						id={`${id}-${level}`}
						type="button"
						// biome-ignore lint/a11y/useSemanticElements: custom pill styling; ARIA radio semantics preserved
						role="radio"
						aria-checked={selected}
						tabIndex={selected || (value === null && level === 1) ? 0 : -1}
						onClick={() => onChange(selected ? null : level)}
						onKeyDown={(e) => onKeyDown(e, level)}
						className={cn(
							'grid size-7 cursor-pointer place-items-center rounded-full border font-mono text-[11px] font-bold outline-none transition-colors',
							selected
								? 'border-brand bg-brand text-brand-foreground'
								: 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground',
							'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
						)}
					>
						{level}
					</button>
				)
			})}
			<span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
				or higher
			</span>
		</div>
	)
}

// ─── TargetTypePills ──────────────────────────────────────────────────────

function TargetTypePills({
	id,
	value,
	onChange,
}: {
	id: string
	value: CommentFilterState['onTargetType']
	onChange: (next: CommentFilterState['onTargetType']) => void
}) {
	const onKeyDown = (
		e: React.KeyboardEvent<HTMLButtonElement>,
		current: CommentFilterState['onTargetType'],
	) => {
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault()
			const idx = TARGET_TYPE_OPTIONS.findIndex((o) => o.value === current)
			const next = TARGET_TYPE_OPTIONS[Math.min(TARGET_TYPE_OPTIONS.length - 1, idx + 1)]
			onChange(next.value)
			document.getElementById(`${id}-${next.value}`)?.focus()
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault()
			const idx = TARGET_TYPE_OPTIONS.findIndex((o) => o.value === current)
			const next = TARGET_TYPE_OPTIONS[Math.max(0, idx - 1)]
			onChange(next.value)
			document.getElementById(`${id}-${next.value}`)?.focus()
		} else if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault()
			onChange(current)
		}
	}

	return (
		<div
			id={id}
			role="radiogroup"
			aria-label="Target object type"
			className="flex flex-wrap items-center gap-2"
		>
			{TARGET_TYPE_OPTIONS.map((option) => {
				const selected = value === option.value
				return (
					<button
						key={option.value}
						id={`${id}-${option.value}`}
						type="button"
						// biome-ignore lint/a11y/useSemanticElements: custom pill styling; ARIA radio semantics preserved
						role="radio"
						aria-checked={selected}
						tabIndex={selected ? 0 : -1}
						onClick={() => onChange(option.value)}
						onKeyDown={(e) => onKeyDown(e, option.value)}
						className={cn(
							'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[11.5px] font-semibold outline-none transition-colors sm:min-h-8',
							selected
								? 'border-brand bg-brand-subtle text-brand-subtle-foreground'
								: 'border-border bg-muted text-muted-foreground hover:border-border-strong hover:text-foreground',
							'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
						)}
					>
						<span
							aria-hidden="true"
							className={cn(
								'size-1.5 rounded-full',
								option.dot === 'bet' && 'bg-type-bet-text',
								option.dot === 'task' && 'bg-type-task-text',
								option.dot === 'insight' && 'bg-type-insight-text',
								option.dot === 'any' && 'bg-muted-foreground',
							)}
						/>
						{option.label}
					</button>
				)
			})}
		</div>
	)
}

// ─── ActorAutocomplete ────────────────────────────────────────────────────
//
// Actor picker for author + mentions rows. Popover with search input,
// role="listbox" per UI spec §Accessibility. Falls back to a "no matching
// actors" copy when the query has no hits.

interface Actor {
	id: string
	name: string
	type: string
}

function ActorAutocomplete({
	id,
	actors,
	selectedId,
	placeholder,
	onChange,
}: {
	id: string
	actors: Actor[]
	selectedId: string | null
	placeholder: string
	onChange: (id: string | null) => void
}) {
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState('')

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase()
		if (!q) return actors
		return actors.filter((a) => a.name.toLowerCase().includes(q))
	}, [actors, search])

	const selected = selectedId ? actors.find((a) => a.id === selectedId) : null

	return (
		<ResponsivePopover open={open} onOpenChange={setOpen}>
			<ResponsivePopoverTrigger asChild>
				<button
					id={id}
					type="button"
					// biome-ignore lint/a11y/useSemanticElements: combobox trigger — a native <select> can't render a popover with search + custom rows
					role="combobox"
					aria-expanded={open}
					aria-haspopup="listbox"
					aria-controls={`${id}-listbox`}
					className={cn(
						'flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-3 text-left text-[12.5px] outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:min-h-9',
						selected ? 'text-foreground' : 'text-muted-foreground',
					)}
				>
					{selected ? (
						<span className="flex min-w-0 items-center gap-1.5">
							<ActorAvatar
								id={selected.id}
								name={selected.name}
								type={selected.type === 'agent' ? 'agent' : 'human'}
							/>
							<span className="truncate font-semibold">{selected.name}</span>
						</span>
					) : (
						<span className="truncate">{placeholder}</span>
					)}
					<span className="flex items-center gap-1.5">
						{selected && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
								aria-label="Clear selection"
								onClick={(e) => {
									e.stopPropagation()
									onChange(null)
								}}
							>
								<X size={12} />
							</Button>
						)}
						<ChevronDown size={14} className="text-muted-foreground" aria-hidden="true" />
					</span>
				</button>
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent className="w-[--radix-popover-trigger-width] p-0">
				<div className="border-b border-border px-2 py-1.5">
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search actors…"
						aria-label="Search actors"
						className="h-8 text-xs"
					/>
				</div>
				<div
					id={`${id}-listbox`}
					// biome-ignore lint/a11y/useSemanticElements: <select> can't hold the search input + custom row layout
					role="listbox"
					aria-label="Actors"
					tabIndex={-1}
					className="max-h-64 overflow-y-auto py-1"
				>
					{filtered.length === 0 ? (
						<div className="px-3 py-2 text-[11.5px] text-muted-foreground">
							No matching actors — try a different name.
						</div>
					) : (
						filtered.map((a) => (
							<button
								key={a.id}
								type="button"
								// biome-ignore lint/a11y/useSemanticElements: custom row with avatar + name; role="option" preserves semantics
								role="option"
								aria-selected={selectedId === a.id}
								onClick={() => {
									onChange(a.id)
									setOpen(false)
									setSearch('')
								}}
								className={cn(
									'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-accent',
									selectedId === a.id && 'bg-accent text-accent-foreground',
								)}
							>
								<ActorAvatar
									id={a.id}
									name={a.name}
									type={a.type === 'agent' ? 'agent' : 'human'}
								/>
								<span className="truncate">{a.name}</span>
							</button>
						))
					)}
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
