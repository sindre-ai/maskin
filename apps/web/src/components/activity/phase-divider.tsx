import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'

interface PhaseDividerProps {
	status: string
	startedAt: string | null
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

export function PhaseDivider({ status, startedAt }: PhaseDividerProps) {
	const colors = getStatusColor(status)
	const formattedDate = formatPhaseDate(startedAt)
	const label = status.replace(/_/g, ' ')

	return (
		<div className="flex items-center gap-3 py-4">
			<div className="flex-1 border-t border-border" />
			<div className="flex items-center gap-2 rounded-full border border-border bg-bg-surface px-3 py-1">
				<span className={cn('inline-block h-2 w-2 rounded-full', colors.bg)} aria-hidden="true" />
				<span className={cn('text-xs font-medium uppercase tracking-wider', colors.text)}>
					{label}
				</span>
				{formattedDate && <span className="text-xs text-muted-foreground">{formattedDate}</span>}
			</div>
			<div className="flex-1 border-t border-border" />
		</div>
	)
}
