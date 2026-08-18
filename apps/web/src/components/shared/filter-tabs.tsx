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
	variant?: 'tab' | 'pill'
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
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a filter toggle group is more idiomatic as role="group"
		<div
			role="group"
			aria-label={ariaLabel}
			className={cn('flex overflow-x-auto', isPill ? 'gap-2' : 'gap-1', className)}
		>
			{tabs.map((tab) => {
				const isActive = tab.value === value
				// The count is spoken with parentheses but drawn without them — the
				// mockup renders a bare dimmer numeral beside the label.
				const accessibleName = tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label
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
						{tab.count !== undefined && (
							<span
								aria-hidden="true"
								className={cn(
									'tabular-nums',
									isPill ? 'text-[10.5px] opacity-70' : 'ml-1 text-muted-foreground',
								)}
							>
								{tab.count}
							</span>
						)}
					</button>
				)
			})}
		</div>
	)
}
