import { cn } from '@/lib/cn'

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
	variant?: 'tab' | 'pill' | 'nav'
}

export function FilterTabs<T extends string | undefined>({
	tabs,
	value,
	onChange,
	className,
	'aria-label': ariaLabel,
	variant = 'tab',
}: FilterTabsProps<T>) {
	const isPill = variant === 'pill'
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
			{tabs.map((tab) => {
				const isActive = tab.value === value
				// The count is spoken with parentheses but drawn without them — the
				// mockup renders a bare dimmer numeral beside the label.
				const accessibleName = tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label
				// `nav` draws the count on the selected tab only (mockup 151's
				// `sc-if t.on`), but every tab still *announces* its count above.
				const drawCount = tab.count !== undefined && (!isNav || isActive)
				return (
					<button
						key={tab.label}
						type="button"
						aria-pressed={isActive}
						aria-label={accessibleName}
						className={cn(
							'whitespace-nowrap transition-colors duration-150',
							isPill
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
									isPill
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
			})}
		</div>
	)
}
