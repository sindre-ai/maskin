import { cn } from '@/lib/cn'

export interface FilterTabItem<T> {
	label: string
	value: T
	/** Optional count rendered after the label, e.g. "Working (3)". */
	count?: number
}

interface FilterTabsProps<T> {
	tabs: FilterTabItem<T>[]
	value: T
	onChange: (value: T) => void
	className?: string
	'aria-label'?: string
}

/**
 * Shared segmented filter used across list screens (Objects, Activity, Agents,
 * Triggers). Replaces the per-page hand-rolled `rounded px-3 py-1` pills so the
 * active-tab styling, spacing, and a11y semantics stay consistent everywhere.
 */
export function FilterTabs<T extends string | undefined>({
	tabs,
	value,
	onChange,
	className,
	'aria-label': ariaLabel,
}: FilterTabsProps<T>) {
	return (
		<div
			role="tablist"
			aria-label={ariaLabel}
			className={cn('flex gap-1 overflow-x-auto', className)}
		>
			{tabs.map((tab) => {
				const isActive = tab.value === value
				return (
					<button
						key={tab.label}
						type="button"
						role="tab"
						aria-selected={isActive}
						className={cn(
							'rounded px-3 py-1 text-sm whitespace-nowrap transition-colors',
							isActive
								? 'bg-muted text-foreground font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
						onClick={() => onChange(tab.value)}
					>
						{tab.label}
						{tab.count !== undefined && (
							<span className="ml-1 text-muted-foreground tabular-nums">{tab.count}</span>
						)}
					</button>
				)
			})}
		</div>
	)
}
