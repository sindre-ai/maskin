import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'

interface PhaseDividerProps {
	status: string
	startedAt: string | null
	isOpen: boolean
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

export function PhaseDivider({ status, startedAt, isOpen, onToggle }: PhaseDividerProps) {
	const colors = getStatusColor(status)
	const formattedDate = formatPhaseDate(startedAt)
	const label = status.replace(/_/g, ' ')

	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={isOpen}
			className="flex w-full cursor-pointer items-center gap-3 py-4 transition-colors hover:bg-bg-hover/40"
		>
			<div className="flex-1 border-t border-border" />
			<span className={cn('inline-block h-2 w-2 rounded-full', colors.bg)} aria-hidden="true" />
			<span className={cn('text-xs font-medium uppercase tracking-wider', colors.text)}>
				{label}
			</span>
			{formattedDate && <span className="text-xs text-muted-foreground">{formattedDate}</span>}
			<div className="flex-1 border-t border-border" />
		</button>
	)
}
