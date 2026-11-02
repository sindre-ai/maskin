import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PILL_TRIGGER_CLASS } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import { fitChips } from '@/lib/fit-chips'
import { ChevronDown } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

export interface FilterTabItem<T> {
	label: string
	value: T
	count?: number
	// A semantic colour token class for the leading dot (e.g. `bg-status-define-text`
	// or `bg-type-bet-bg`). Never a raw colour. Only rendered by the `pill` variant.
	dot?: string
	// Object types read as square swatches, statuses as round dots — the mockup
	// uses both (2px radius at line 286, 50% at line 908).
	dotShape?: 'round' | 'square'
}

interface FilterTabsProps<T> {
	tabs: FilterTabItem<T>[]
	value: T
	onChange: (value: T) => void
	className?: string
	'aria-label'?: string
	// `tab` is the quiet in-toolbar toggle. `pill` is the v2 filter chip — 28px,
	// fully round, bordered, dark-filled when active — used by the For You feed,
	// the Objects axis row, Search and Marketplace. Before this variant existed
	// that chip was hand-written in four places.
	//
	// `nav` is the type-tab strip that sits beside a screen's <h1> in the shared
	// nav row (mockup 146–154): 28px, square-ish radius, muted fill when active,
	// and — unlike the other two — a count on the *active* tab only. The mockup
	// deliberately drops the inactive counts so the strip reads as a heading
	// continuation rather than a row of stats.
	// `chip` and `chip-outline` are the Agents page's 32px chips (v11): `chip` is the
	// filled status chip, `chip-outline` the outlined team chip. Both go dark when active.
	variant?: 'tab' | 'pill' | 'nav' | 'chip' | 'chip-outline'
	// `pill` only. Shows every chip while they fit in the width of the parent row
	// and folds the ones that do not into a "More" menu (the Items type chips).
	// The first chip never folds. Measured before paint, so there is no flash of
	// the unfolded row.
	foldable?: boolean
}

function TabButton<T extends string | undefined>({
	tab,
	value,
	onChange,
	variant,
}: {
	tab: FilterTabItem<T>
	value: T
	onChange: (value: T) => void
	variant: 'tab' | 'pill' | 'nav' | 'chip' | 'chip-outline'
}) {
	const isChip = variant === 'chip' || variant === 'chip-outline'
	const isPill = variant === 'pill' || isChip
	const isNav = variant === 'nav'
	const isActive = tab.value === value
	// The count is spoken with parentheses but drawn without them — the
	// mockup renders a bare dimmer numeral beside the label.
	const accessibleName = tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label
	// `nav` draws the count on the selected tab only (mockup 151's
	// `sc-if t.on`), but every tab still *announces* its count above.
	const drawCount = tab.count !== undefined && (!isNav || isActive)
	return (
		<button
			type="button"
			aria-pressed={isActive}
			aria-label={accessibleName}
			className={cn(
				'whitespace-nowrap transition-colors duration-150',
				isChip
					? cn(
							'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold',
							isActive
								? 'border-primary bg-primary text-primary-foreground'
								: variant === 'chip'
									? 'border-transparent bg-muted text-foreground hover:bg-border'
									: 'border-border bg-transparent text-muted-foreground hover:border-border-hover hover:text-foreground',
						)
					: isPill
						? cn(
								'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-semibold',
								isActive
									? 'border-primary bg-primary text-primary-foreground'
									: 'border-border bg-transparent text-muted-foreground hover:border-border-hover hover:text-foreground',
							)
						: isNav
							? cn(
									'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-[11px] text-[12.5px]',
									isActive
										? 'bg-muted font-bold text-foreground'
										: 'font-semibold text-muted-foreground/70 hover:text-foreground',
								)
							: cn(
									'rounded px-3 py-1 text-sm',
									isActive
										? 'bg-muted font-medium text-foreground'
										: 'text-muted-foreground hover:text-foreground',
								),
			)}
			onClick={() => onChange(tab.value)}
		>
			{isPill && tab.dot && (
				<span
					aria-hidden="true"
					className={cn(
						'size-1.5 shrink-0',
						tab.dotShape === 'square' ? 'rounded-[2px]' : 'rounded-full',
						tab.dot,
					)}
				/>
			)}
			{tab.label}
			{drawCount && (
				<span
					aria-hidden="true"
					className={cn(
						'tabular-nums',
						isChip
							? 'text-[13px] font-medium opacity-60'
							: isPill
								? 'text-[10.5px] opacity-70'
								: isNav
									? 'text-[11px] font-semibold text-muted-foreground'
									: 'ml-1 text-muted-foreground',
					)}
				>
					{/* The mockup groups thousands (`toLocaleString`) — a bare
					    `1063` beside a heading reads as an id, not a count. */}
					{isNav ? tab.count?.toLocaleString('en-US') : tab.count}
				</span>
			)}
		</button>
	)
}

// Gap between two pill chips (`gap-2`), in px — the fold measures with it.
const PILL_GAP = 8

function FoldablePillTabs<T extends string | undefined>({
	tabs,
	value,
	onChange,
	className,
	'aria-label': ariaLabel,
	variant = 'pill',
}: Omit<FilterTabsProps<T>, 'variant' | 'foldable'> & { variant?: 'pill' | 'chip' }) {
	const isChip = variant === 'chip'
	const wrapRef = useRef<HTMLDivElement>(null)
	const measureRef = useRef<HTMLDivElement>(null)
	// Folded until measured: the layout effect below runs before paint, so the
	// first frame the user sees is already the right one.
	const [visibleCount, setVisibleCount] = useState(1)

	useLayoutEffect(() => {
		const wrap = wrapRef.current
		const measure = measureRef.current
		if (!wrap || !measure) return
		const row = wrap.parentElement ?? wrap
		function recompute() {
			if (!wrap || !measure) return
			const chips = Array.from(measure.children) as HTMLElement[]
			const moreChip = chips.pop()
			const widths = chips.map((c) => c.getBoundingClientRect().width)
			const available = (wrap.parentElement ?? wrap).clientWidth
			// Nothing laid out yet (or no layout at all): show the whole row rather
			// than fold everything behind More.
			if (available <= 0) {
				setVisibleCount(tabs.length)
				return
			}
			const next = fitChips({
				available,
				widths,
				moreWidth: moreChip?.getBoundingClientRect().width ?? 0,
				gap: PILL_GAP,
			})
			setVisibleCount((prev) => (prev === next ? prev : next))
		}
		recompute()
		if (typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(recompute)
		observer.observe(row)
		observer.observe(measure)
		return () => observer.disconnect()
	}, [tabs])

	const shown = tabs.slice(0, visibleCount)
	const folded = tabs.slice(visibleCount)
	const activeFolded = folded.find((t) => t.value === value)
	const foldedCount = folded.reduce((sum, t) => sum + (t.count ?? 0), 0)

	return (
		<div ref={wrapRef} className={cn('relative flex gap-2', className)}>
			{/* biome-ignore lint/a11y/useSemanticElements: a filter toggle group is more idiomatic as role="group" than a <fieldset> */}
			<div role="group" aria-label={ariaLabel} className="flex gap-2">
				{shown.map((tab) => (
					<TabButton
						key={tab.label}
						tab={tab}
						value={value}
						onChange={onChange}
						variant={variant}
					/>
				))}
				{folded.length > 0 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={`More (${folded.length})`}
								className={cn(
									PILL_TRIGGER_CLASS,
									'inline-flex duration-150',
									activeFolded &&
										'border-primary bg-primary text-primary-foreground hover:border-primary',
								)}
							>
								{activeFolded ? activeFolded.label : 'More'}
								<span
									aria-hidden="true"
									className={cn('tabular-nums', 'text-[13px] font-medium opacity-60')}
								>
									{activeFolded ? (activeFolded.count ?? folded.length) : foldedCount}
								</span>
								<ChevronDown aria-hidden="true" className="size-3.5 opacity-70" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuRadioGroup
								value={activeFolded ? String(activeFolded.value) : ''}
								onValueChange={(next) => {
									const tab = folded.find((t) => String(t.value) === next)
									if (tab) onChange(tab.value)
								}}
							>
								{folded.map((tab) => (
									<DropdownMenuRadioItem key={tab.label} value={String(tab.value)}>
										<span className="flex-1">{tab.label}</span>
										{tab.count !== undefined && (
											<span className="ml-3 text-xs tabular-nums text-muted-foreground">
												{tab.count}
											</span>
										)}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			{/* Off-screen copy of every chip plus a worst-case More chip, measured to
			    decide the fold. Invisible, inert and out of the accessibility tree. */}
			<div
				ref={measureRef}
				aria-hidden="true"
				className="pointer-events-none invisible absolute top-0 left-0 flex gap-2"
			>
				{tabs.map((tab) => (
					<span key={tab.label} className="flex">
						<TabButton tab={tab} value={value} onChange={() => {}} variant={variant} />
					</span>
				))}
				<span className={cn(PILL_TRIGGER_CLASS, 'inline-flex')}>
					More <span className="text-[13px]">000</span>
					<ChevronDown className="size-3.5" />
				</span>
			</div>
		</div>
	)
}

export function FilterTabs<T extends string | undefined>({
	tabs,
	value,
	onChange,
	className,
	'aria-label': ariaLabel,
	variant = 'tab',
	foldable = false,
}: FilterTabsProps<T>) {
	if (foldable && (variant === 'pill' || variant === 'chip')) {
		return (
			<FoldablePillTabs
				variant={variant}
				tabs={tabs}
				value={value}
				onChange={onChange}
				className={className}
				aria-label={ariaLabel}
			/>
		)
	}
	const isPill = variant === 'pill' || variant === 'chip' || variant === 'chip-outline'
	const isNav = variant === 'nav'
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a filter toggle group is more idiomatic as role="group"
		<div
			role="group"
			aria-label={ariaLabel}
			className={cn(
				'flex overflow-x-auto',
				isPill ? 'gap-2' : isNav ? 'gap-0.5' : 'gap-1',
				className,
			)}
		>
			{tabs.map((tab) => (
				<TabButton key={tab.label} tab={tab} value={value} onChange={onChange} variant={variant} />
			))}
		</div>
	)
}
