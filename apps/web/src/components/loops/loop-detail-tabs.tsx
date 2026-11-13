import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { fitChips } from '@/lib/fit-chips'
import { ChevronDown, Plus } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

export interface LoopTabItem {
	value: string
	label: string
	count?: number
	/** A hairline sits in the gap before this tab, setting it and the tabs after it apart. */
	startsGroup?: boolean
}

// Gap between two tabs (`gap-6`), in px — the fold measures with it.
const TAB_GAP = 24

// Width held back at the row's right edge for the add button, in px.
const ADD_WIDTH = 36

const GROUP_CLASS =
	'relative before:absolute before:-left-3 before:top-1/2 before:h-[18px] before:w-px before:-translate-y-1/2 before:bg-border'

const TAB_CLASS =
	'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 pt-2 pb-3 text-[15px] transition-colors duration-150'

function tabClass(active: boolean, startsGroup = false) {
	return cn(
		TAB_CLASS,
		startsGroup && GROUP_CLASS,
		active
			? 'border-foreground font-bold text-foreground'
			: 'border-transparent font-medium text-muted-foreground hover:text-foreground',
	)
}

/**
 * The flow page's tab strip. Tabs that do not fit the row fold under "More"
 * (measured with the same `fitChips` rule the Items filter chips use), so no
 * tab ever scrolls sideways or clips. The first tab never folds.
 */
export function LoopDetailTabs({
	tabs,
	value,
	onChange,
	onAdd,
	addLabel = 'Add',
}: {
	tabs: LoopTabItem[]
	value: string
	onChange: (value: string) => void
	/** Shows a "+" at the row's right edge. Omitted, no button is offered. */
	onAdd?: () => void
	addLabel?: string
}) {
	const rowRef = useRef<HTMLDivElement>(null)
	const measureRef = useRef<HTMLDivElement>(null)
	// Folded until measured; the layout effect runs before paint.
	const [visibleCount, setVisibleCount] = useState(tabs.length)

	useLayoutEffect(() => {
		const row = rowRef.current
		const measure = measureRef.current
		if (!row || !measure) return
		function recompute() {
			if (!row || !measure) return
			const chips = Array.from(measure.children) as HTMLElement[]
			const more = chips.pop()
			const available = row.clientWidth - (onAdd ? ADD_WIDTH : 0)
			if (available <= 0) {
				setVisibleCount(tabs.length)
				return
			}
			const next = fitChips({
				available,
				widths: chips.map((c) => c.getBoundingClientRect().width),
				moreWidth: more?.getBoundingClientRect().width ?? 0,
				gap: TAB_GAP,
			})
			setVisibleCount((prev) => (prev === next ? prev : next))
		}
		recompute()
		if (typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(recompute)
		observer.observe(row)
		observer.observe(measure)
		return () => observer.disconnect()
	}, [tabs, onAdd])

	const shown = tabs.slice(0, visibleCount)
	const folded = tabs.slice(visibleCount)
	const activeFolded = folded.find((t) => t.value === value)

	return (
		<div ref={rowRef} className="relative border-b border-border">
			<div role="tablist" aria-label="Flow sections" className="flex gap-6 px-1">
				{shown.map((tab) => (
					<button
						key={tab.value}
						type="button"
						role="tab"
						aria-selected={tab.value === value}
						onClick={() => onChange(tab.value)}
						className={tabClass(tab.value === value, tab.startsGroup)}
					>
						{tab.label}
						{tab.count !== undefined && tab.count > 0 && (
							<span className="text-[12px] font-bold tabular-nums text-brand">{tab.count}</span>
						)}
					</button>
				))}
				{folded.length > 0 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={`More (${folded.length})`}
								className={tabClass(Boolean(activeFolded))}
							>
								{activeFolded ? activeFolded.label : 'More'}
								<ChevronDown size={12} aria-hidden="true" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuRadioGroup
								value={activeFolded?.value ?? ''}
								onValueChange={(next) => onChange(next)}
							>
								{folded.map((tab) => (
									<DropdownMenuRadioItem key={tab.value} value={tab.value}>
										{tab.label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			{onAdd && (
				<button
					type="button"
					onClick={onAdd}
					aria-label={addLabel}
					title={addLabel}
					className="absolute right-0 top-1 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<Plus size={16} aria-hidden="true" />
				</button>
			)}
			{/* Off-screen copy of every tab plus a worst-case More, measured to decide the fold. */}
			<div
				ref={measureRef}
				aria-hidden="true"
				className="pointer-events-none invisible absolute top-0 left-0 flex gap-6 px-1"
			>
				{tabs.map((tab) => (
					<span key={tab.value} className={tabClass(false, tab.startsGroup)}>
						{tab.label}
						{tab.count !== undefined && tab.count > 0 && (
							<span className="text-[12px] font-bold tabular-nums">{tab.count}</span>
						)}
					</span>
				))}
				<span className={tabClass(false)}>
					More
					<ChevronDown size={12} />
				</span>
			</div>
		</div>
	)
}
