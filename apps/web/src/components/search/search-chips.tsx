import { cn } from '@/lib/cn'
import type { StatusChip, TypeChip } from '@/lib/search/chips'
import type { StatusGroup } from '@/lib/search/vocabulary'

// Colours come from the app's status tokens; the five groups share the same
// meaning for every type, so they share one dot colour each.
const STATUS_DOT: Record<StatusGroup, string> = {
	needs_you: 'bg-warning',
	in_progress: 'bg-brand',
	new: 'bg-muted-foreground',
	done: 'bg-success',
	archived: 'bg-border-strong',
}

export function statusDotClass(group: string): string {
	return STATUS_DOT[group as StatusGroup] ?? 'bg-muted-foreground'
}

interface ChipProps {
	label: string
	/** Null shows a dash: the count has not arrived yet. */
	count: number | null
	selected: boolean
	onToggle: () => void
	dot?: string
}

// Same pill as FilterTabs (28px, fully round, dark when selected, 44px under the
// app's mobile rule). FilterTabs holds one value; these chips are a multi-select.
function Chip({ label, count, selected, onToggle, dot }: ChipProps) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			aria-label={count === null ? label : `${label} (${count})`}
			onClick={onToggle}
			className={cn(
				'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[11.5px] font-semibold transition-colors duration-150 max-[1024.02px]:min-h-11',
				selected
					? 'border-primary bg-primary text-primary-foreground'
					: 'border-border bg-transparent text-muted-foreground hover:border-border-hover hover:text-foreground',
			)}
		>
			{dot ? (
				<span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dot)} />
			) : null}
			{label}
			<span aria-hidden="true" className="tabular-nums text-[10.5px] opacity-70">
				{count === null ? '–' : count}
			</span>
		</button>
	)
}

// The rows wrap instead of scrolling sideways, so no chip is ever hidden off-screen
// without a hint, and the Display button next to them cannot cover one.
const ROW = 'flex min-w-0 flex-1 flex-wrap items-center gap-2'

export function TypeChips({
	chips,
	onToggle,
	dimmed,
}: {
	chips: TypeChip[]
	onToggle: (key: string) => void
	dimmed?: boolean
}) {
	if (chips.length === 0) return null
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a filter toggle group is more idiomatic as role="group" (same as FilterTabs)
		<div role="group" aria-label="Filter by type" className={cn(ROW, dimmed && 'opacity-60')}>
			{chips.map((chip) => (
				<Chip
					key={chip.key}
					label={chip.label}
					count={chip.count}
					selected={chip.selected}
					onToggle={() => onToggle(chip.key)}
				/>
			))}
		</div>
	)
}

export function StatusChips({
	chips,
	onToggle,
	dimmed,
}: {
	chips: StatusChip[]
	onToggle: (key: string) => void
	dimmed?: boolean
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a filter toggle group is more idiomatic as role="group" (same as FilterTabs)
		<div role="group" aria-label="Filter by status" className={cn(ROW, dimmed && 'opacity-60')}>
			{chips.map((chip) => (
				<Chip
					key={chip.key}
					label={chip.label}
					count={chip.count}
					selected={chip.selected}
					onToggle={() => onToggle(chip.key)}
					dot={statusDotClass(chip.key)}
				/>
			))}
		</div>
	)
}
