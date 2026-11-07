import { cn } from '@/lib/cn'
import type { StatusChip, TypeChip } from '@/lib/search/chips'
import type { ReactNode } from 'react'
import { statusDotClass } from './search-chips'

// The search page's filters as the v3 form: a small section label over a ruled list.
// Choice rows toggle a filter in place; the picked ones say "Selected" in cobalt.

const ROW =
	'flex min-h-11.5 w-full items-center gap-3 border-b border-border px-2 text-left text-[15px] font-medium text-foreground'

export function FormSection({
	label,
	children,
	className,
}: {
	label: string
	children: ReactNode
	className?: string
}) {
	return (
		<section aria-label={label} className={cn('flex flex-col', className)}>
			<h2 className="border-b border-border px-2 pb-2 text-sm font-semibold text-muted-foreground">
				{label}
			</h2>
			{children}
		</section>
	)
}

/** A label at the left, a control at the right. */
export function FormRow({
	label,
	children,
	className,
}: {
	label: string
	children: ReactNode
	className?: string
}) {
	return (
		<div className={cn(ROW, 'justify-between py-1.5', className)}>
			<span aria-hidden="true" className="shrink-0">
				{label}
			</span>
			<div className="flex min-w-0 flex-1 justify-end">{children}</div>
		</div>
	)
}

function ChoiceRow({
	label,
	count,
	selected,
	onClick,
	leading,
	hideSelected,
}: {
	label: string
	count?: number | null
	selected: boolean
	onClick: () => void
	leading?: ReactNode
	hideSelected?: boolean
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onClick}
			className={cn(ROW, 'transition-colors hover:bg-muted/50')}
		>
			{leading}
			<span className="min-w-0 truncate">{label}</span>
			{count === undefined ? null : (
				<span className="-ml-1.5 tabular-nums">{count === null ? '–' : count}</span>
			)}
			{selected && !hideSelected ? (
				<span className="ml-auto shrink-0 text-sm font-medium text-brand">Selected</span>
			) : null}
		</button>
	)
}

/** "All" plus one row per type; All is selected while no type is. */
export function TypeRows({
	chips,
	onToggle,
	onClear,
	showCounts,
}: {
	chips: TypeChip[]
	onToggle: (key: string) => void
	onClear: () => void
	showCounts: boolean
}) {
	const none = !chips.some((c) => c.selected)
	return (
		<>
			<ChoiceRow label="All" selected={none} onClick={onClear} />
			{chips.map((chip) => (
				<ChoiceRow
					key={chip.key}
					label={chip.label}
					count={showCounts ? chip.count : undefined}
					selected={chip.selected}
					onClick={() => onToggle(chip.key)}
				/>
			))}
		</>
	)
}

export function StatusRows({
	chips,
	onToggle,
	onClear,
	showCounts,
}: {
	chips: StatusChip[]
	onToggle: (key: string) => void
	onClear: () => void
	showCounts: boolean
}) {
	const none = !chips.some((c) => c.selected)
	return (
		<>
			<ChoiceRow label="Any status" selected={none} onClick={onClear} />
			{chips.map((chip) => (
				<ChoiceRow
					key={chip.key}
					label={chip.label}
					count={showCounts ? chip.count : undefined}
					selected={chip.selected}
					onClick={() => onToggle(chip.key)}
					leading={
						<span
							aria-hidden="true"
							className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(chip.key))}
						/>
					}
				/>
			))}
		</>
	)
}
