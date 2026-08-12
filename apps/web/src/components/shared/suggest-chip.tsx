import { cn } from '@/lib/cn'
import { CornerDownLeft, Search } from 'lucide-react'

interface SuggestChipProps {
	label: string
	onSelect?: () => void
	className?: string
}

/**
 * "Try asking…" suggestion chip: a bordered row with a leading search glyph,
 * the suggestion text, and a trailing ↵ return hint. Token-driven, no
 * hardcoded colour or radius.
 */
export function SuggestChip({ label, onSelect, className }: SuggestChipProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				'flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left text-sm text-foreground transition-colors',
				'hover:border-foreground hover:bg-secondary hover:text-foreground',
				'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				className,
			)}
		>
			<Search size={13} className="shrink-0 text-muted-foreground" aria-hidden />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<CornerDownLeft size={13} className="shrink-0 text-muted-foreground" aria-hidden />
		</button>
	)
}
