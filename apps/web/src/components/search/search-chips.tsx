import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PILL_TRIGGER_CLASS } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import type { StatusChip, TypeChip } from '@/lib/search/chips'
import type { ParticipantOption, StatusGroup } from '@/lib/search/vocabulary'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

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

/** "Type" with nothing chosen; "Type: Items, Chats" for one or two; "Type: 3" beyond that. */
export function pillSummary(name: string, labels: string[]): string {
	if (labels.length === 0) return name
	if (labels.length <= 2) return `${name}: ${labels.join(', ')}`
	return `${name}: ${labels.length}`
}

/** The v16 dropdown pill the search page's one filter row is made of. */
export function FilterPillTrigger({
	label,
	active,
	dimmed,
}: {
	label: string
	active: boolean
	dimmed?: boolean
}) {
	return (
		<DropdownMenuTrigger
			className={cn(
				PILL_TRIGGER_CLASS,
				'inline-flex max-w-full',
				active && 'border-border-strong',
				dimmed && 'opacity-60',
			)}
		>
			<span className="truncate">{label}</span>
			<ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
		</DropdownMenuTrigger>
	)
}

const MENU = 'max-h-[min(70dvh,var(--radix-dropdown-menu-content-available-height))] w-60'

// Counts live inside the menus, so the row of pills never changes width while an answer loads.
function Count({ value, show }: { value: number | null; show: boolean }) {
	if (!show) return null
	return (
		<span aria-hidden="true" className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">
			{value === null ? '–' : value}
		</span>
	)
}

// A row keeps the menu open while a filter is toggled, so several can be picked in a row.
function MultiRow({
	label,
	count,
	showCount,
	selected,
	onToggle,
	leading,
}: {
	label: string
	count: number | null
	showCount: boolean
	selected: boolean
	onToggle: () => void
	leading?: ReactNode
}) {
	return (
		<DropdownMenuCheckboxItem
			checked={selected}
			onSelect={(e) => {
				e.preventDefault()
				onToggle()
			}}
			className="max-[1024.02px]:min-h-11"
		>
			{leading}
			<span className="truncate">{label}</span>
			<Count value={count} show={showCount} />
		</DropdownMenuCheckboxItem>
	)
}

interface ChipsProps<T> {
	chips: T[]
	onToggle: (key: string) => void
	dimmed?: boolean
	/** False hides the counts: nothing has been asked, so there is no answer to wait for. */
	showCounts?: boolean
}

export function TypeFilter({ chips, onToggle, dimmed, showCounts = true }: ChipsProps<TypeChip>) {
	if (chips.length === 0) return null
	const selected = chips.filter((c) => c.selected).map((c) => c.label)
	return (
		<DropdownMenu>
			<FilterPillTrigger
				label={pillSummary('Type', selected)}
				active={selected.length > 0}
				dimmed={dimmed}
			/>
			<DropdownMenuContent align="start" className={MENU}>
				{chips.map((chip) => (
					<MultiRow
						key={chip.key}
						label={chip.label}
						count={chip.count}
						showCount={showCounts}
						selected={chip.selected}
						onToggle={() => onToggle(chip.key)}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function StatusFilter({
	chips,
	onToggle,
	dimmed,
	showCounts = true,
}: ChipsProps<StatusChip>) {
	const selected = chips.filter((c) => c.selected).map((c) => c.label)
	return (
		<DropdownMenu>
			<FilterPillTrigger
				label={pillSummary('Status', selected)}
				active={selected.length > 0}
				dimmed={dimmed}
			/>
			<DropdownMenuContent align="start" className={MENU}>
				{chips.map((chip) => (
					<MultiRow
						key={chip.key}
						label={chip.label}
						count={chip.count}
						showCount={showCounts}
						selected={chip.selected}
						onToggle={() => onToggle(chip.key)}
						leading={
							<span
								aria-hidden="true"
								className={cn('mr-2 size-1.5 shrink-0 rounded-full', statusDotClass(chip.key))}
							/>
						}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function ParticipantFilter({
	options,
	selectedIds,
	onToggle,
}: {
	options: ParticipantOption[]
	selectedIds: string[]
	onToggle: (option: ParticipantOption) => void
}) {
	const names = selectedIds.map((id) => options.find((o) => o.id === id)?.name ?? 'Someone')
	return (
		<DropdownMenu>
			<FilterPillTrigger
				label={pillSummary('Participant', names)}
				active={selectedIds.length > 0}
			/>
			<DropdownMenuContent align="start" className={MENU}>
				{options.map((option) => (
					<MultiRow
						key={option.id}
						label={option.name}
						count={null}
						showCount={false}
						selected={selectedIds.includes(option.id)}
						onToggle={() => onToggle(option)}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/** One-of-many pill (Updated, Sort): radio rows. */
export function RadioFilter<T extends string>({
	name,
	value,
	options,
	onChange,
	summary,
	active,
	className,
}: {
	name: string
	value: T
	options: Array<{ value: T; label: string }>
	onChange: (value: T) => void
	/** The pill's text. */
	summary: string
	active: boolean
	className?: string
}) {
	return (
		<DropdownMenu>
			<span className={cn('flex min-w-0', className)}>
				<FilterPillTrigger label={summary} active={active} />
			</span>
			<DropdownMenuContent align="end" className="w-52" aria-label={name}>
				<DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
					{options.map((o) => (
						<DropdownMenuRadioItem
							key={o.value || 'any'}
							value={o.value || 'any'}
							className="max-[1024.02px]:min-h-11"
						>
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
