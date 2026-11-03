import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { cn } from '@/lib/cn'
import type { TypeChip } from '@/lib/search/chips'
import type { SearchSort, UpdatedFilter } from '@/lib/search/url-state'
import { SlidersHorizontal } from 'lucide-react'

export const SORT_OPTIONS: Array<{ value: SearchSort; label: string }> = [
	{ value: 'rel', label: 'Relevance' },
	{ value: 'recent', label: 'Recently updated' },
	{ value: 'az', label: 'A to Z' },
]

export const UPDATED_OPTIONS: Array<{ value: UpdatedFilter; label: string }> = [
	{ value: '', label: 'Any time' },
	{ value: 'day', label: 'Past day' },
	{ value: 'week', label: 'Past week' },
	{ value: 'month', label: 'Past month' },
]

// Radix radio items cannot hold an empty value, so "no Updated window" is this word here.
const ANY_TIME = 'any'

/** How many Display settings differ from their defaults: a sort other than Relevance, an Updated window. */
export function displayBadgeCount(sort: SearchSort, updated: UpdatedFilter): number {
	return (sort !== 'rel' ? 1 : 0) + (updated !== '' ? 1 : 0)
}

function SectionLabel({ children }: { children: string }) {
	return <p className="eyebrow pb-1">{children}</p>
}

interface DisplayMenuProps {
	sort: SearchSort
	updated: UpdatedFilter
	typeChips: TypeChip[]
	onSortChange: (value: SearchSort) => void
	onUpdatedChange: (value: UpdatedFilter) => void
	onToggleType: (key: string) => void
}

// Display lives in a popover on wide screens and a bottom sheet under 768px (the
// ResponsivePopover rule). Radix closes both on Escape and the sheet has a close
// button. The Type section repeats the chip row, so it only shows in the sheet,
// where the chip row can be long.
export function DisplayMenu({
	sort,
	updated,
	typeChips,
	onSortChange,
	onUpdatedChange,
	onToggleType,
}: DisplayMenuProps) {
	const badge = displayBadgeCount(sort, updated)
	return (
		<ResponsivePopover>
			<ResponsivePopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="shrink-0 gap-1.5 max-[1024.02px]:min-h-11"
					aria-label={badge > 0 ? `Display (${badge} changed)` : 'Display'}
				>
					<SlidersHorizontal aria-hidden="true" className="size-3.5" />
					Display
					{badge > 0 ? (
						<span
							aria-hidden="true"
							className="rounded-full bg-primary px-1.5 text-[10.5px] tabular-nums text-primary-foreground"
						>
							{badge}
						</span>
					) : null}
				</Button>
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent align="end" accessibleTitle="Display" className="text-left md:w-60">
				<div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto pr-1">
					<p className="text-[13px] font-semibold text-foreground max-md:pr-10">Display</p>

					{typeChips.length > 0 ? (
						<fieldset className="md:hidden">
							<legend className="sr-only">Type</legend>
							<SectionLabel>Type</SectionLabel>
							<div className="flex flex-col">
								{typeChips.map((chip) => (
									<label
										key={chip.key}
										htmlFor={`search-type-${chip.key}`}
										className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-[13px] text-foreground"
									>
										<Checkbox
											id={`search-type-${chip.key}`}
											checked={chip.selected}
											onCheckedChange={() => onToggleType(chip.key)}
										/>
										<span className="min-w-0 flex-1 truncate">{chip.label}</span>
										{chip.count !== null ? (
											<span className="text-[11.5px] tabular-nums text-muted-foreground">
												{chip.count}
											</span>
										) : null}
									</label>
								))}
							</div>
						</fieldset>
					) : null}

					<fieldset>
						<legend className="sr-only">Sort</legend>
						<SectionLabel>Sort</SectionLabel>
						<RadioGroup
							value={sort}
							onValueChange={(v) => onSortChange(v as SearchSort)}
							className="gap-0"
						>
							{SORT_OPTIONS.map((o) => (
								<RadioRow
									key={o.value}
									id={`search-sort-${o.value}`}
									value={o.value}
									label={o.label}
								/>
							))}
						</RadioGroup>
					</fieldset>

					<fieldset>
						<legend className="sr-only">Updated</legend>
						<SectionLabel>Updated</SectionLabel>
						<RadioGroup
							value={updated || ANY_TIME}
							onValueChange={(v) => onUpdatedChange(v === ANY_TIME ? '' : (v as UpdatedFilter))}
							className="gap-0"
						>
							{UPDATED_OPTIONS.map((o) => (
								<RadioRow
									key={o.value || ANY_TIME}
									id={`search-updated-${o.value || ANY_TIME}`}
									value={o.value || ANY_TIME}
									label={o.label}
								/>
							))}
						</RadioGroup>
					</fieldset>
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}

function RadioRow({ id, value, label }: { id: string; value: string; label: string }) {
	return (
		<label
			htmlFor={id}
			className={cn(
				'flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-1 text-[13px] text-foreground max-lg:min-h-11',
			)}
		>
			<RadioGroupItem id={id} value={value} />
			{label}
		</label>
	)
}
