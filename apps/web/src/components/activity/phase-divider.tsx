import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface PhaseDividerProps {
	status: string
	startedAt: string | null
	isOpen: boolean
	eventCount: number
	onToggle: () => void
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	weekday: 'long',
	month: 'long',
	day: 'numeric',
})

function formatPhaseDate(value: string | null): string | null {
	if (!value) return null
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return null
	return dateFormatter.format(date)
}

export function PhaseDivider({
	status,
	startedAt,
	isOpen,
	eventCount,
	onToggle,
}: PhaseDividerProps) {
	const colors = getStatusColor(status)
	const formattedDate = formatPhaseDate(startedAt)
	const label = status.replace(/_/g, ' ')

	return (
		<div className="flex items-center gap-3 py-4">
			<div className="flex-1 border-t border-border" />
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={isOpen}
				className="flex cursor-pointer items-center gap-2 rounded-full border border-border bg-bg-surface px-3 py-1 transition-colors hover:border-border-hover hover:bg-bg-hover"
			>
				<span className={cn('inline-block h-2 w-2 rounded-full', colors.bg)} aria-hidden="true" />
				<span className={cn('text-xs font-medium uppercase tracking-wider', colors.text)}>
					{label}
				</span>
				{formattedDate && <span className="text-xs text-muted-foreground">{formattedDate}</span>}
				{!isOpen && eventCount > 0 && (
					<span className="text-xs text-muted-foreground">
						· {eventCount} {eventCount === 1 ? 'event' : 'events'}
					</span>
				)}
				{isOpen ? (
					<ChevronDown size={14} className="text-muted-foreground" aria-hidden="true" />
				) : (
					<ChevronRight size={14} className="text-muted-foreground" aria-hidden="true" />
				)}
			</button>
			<div className="flex-1 border-t border-border" />
		</div>
	)
}
