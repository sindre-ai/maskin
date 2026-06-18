import { cn } from '@/lib/cn'

export interface FilterTab<T> {
	label: string
	value: T
	/** Optional count rendered as a subtle trailing pill. */
	count?: number
}

interface FilterTabsProps<T> {
	tabs: FilterTab<T>[]
	value: T
	onChange: (value: T) => void
	className?: string
	/** Compare function for matching the active tab. Defaults to Object.is. */
	isActive?: (a: T, b: T) => boolean
}

/**
 * Compact, utilitarian segmented filter used across list screens
 * (Objects, Agents, Activity). Near-monochrome, tight control height,
 * with a soft active surface that matches the refined design system.
 */
export function FilterTabs<T>({
	tabs,
	value,
	onChange,
	className,
	isActive = (a, b) => Object.is(a, b),
}: FilterTabsProps<T>) {
	return (
		<div className={cn('flex items-center gap-0.5 overflow-x-auto', className)}>
			{tabs.map((tab) => {
				const active = isActive(tab.value, value)
				return (
					<button
						key={tab.label}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(tab.value)}
						className={cn(
							'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40',
							active
								? 'bg-muted text-foreground shadow-2xs'
								: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
						)}
					>
						{tab.label}
						{tab.count !== undefined && (
							<span
								className={cn(
									'tabular-nums text-xs',
									active ? 'text-muted-foreground' : 'text-muted-foreground/70',
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
