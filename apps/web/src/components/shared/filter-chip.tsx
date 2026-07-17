import { cn } from '@/lib/cn'
import { X } from 'lucide-react'

interface FilterChipProps {
	label: string
	value: string
	onRemove: () => void
	className?: string
}

// Tab-style filter chip for surfacing active toolbar filters. Uses the same
// `bg-muted text-foreground font-medium` pattern as FilterTabs' active state —
// one unified pill style for filter state that lives in the page toolbar. The
// bordered `border-accent` style stays reserved for picker toggles inside
// popovers (see DisplayPanel PillButton).
export function FilterChip({ label, value, onRemove, className }: FilterChipProps) {
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground',
				className,
			)}
		>
			<span className="text-muted-foreground">{label}:</span>
			<span className="capitalize">{value}</span>
			<button
				type="button"
				aria-label={`Remove ${label} filter`}
				title={`Remove ${label} filter`}
				onClick={onRemove}
				className="ml-0.5 -mr-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors"
			>
				<X size={12} />
			</button>
		</span>
	)
}
