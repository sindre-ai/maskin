import { cn } from '@/lib/cn'

export interface FilterTabItem<T> {
	label: string
	value: T
	count?: number
}

interface FilterTabsProps<T> {
	tabs: FilterTabItem<T>[]
	value: T
	onChange: (value: T) => void
	className?: string
	'aria-label'?: string
}

export function FilterTabs<T extends string | undefined>({
	tabs,
	value,
	onChange,
	className,
	'aria-label': ariaLabel,
}: FilterTabsProps<T>) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a filter toggle group is more idiomatic as role="group"
		<div
			role="group"
			aria-label={ariaLabel}
			className={cn('flex gap-1 overflow-x-auto', className)}
		>
			{tabs.map((tab) => {
				const isActive = tab.value === value
				return (
					<button
						key={tab.label}
						type="button"
						aria-pressed={isActive}
						className={cn(
							'rounded px-3 py-1 text-sm whitespace-nowrap transition-colors',
							isActive
								? 'bg-muted text-foreground font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
						onClick={() => onChange(tab.value)}
					>
						{tab.label}
						{tab.count !== undefined && <span className="ml-1 tabular-nums">({tab.count})</span>}
					</button>
				)
			})}
		</div>
	)
}
