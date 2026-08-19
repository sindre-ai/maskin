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

/**
 * The boundary between two phases of an object's life (mockup 1226–1233): the
 * status it entered, the day it entered it, then a rule running out to the
 * right. It reads as a chapter heading, so the label leads the row rather than
 * sitting centred between two rules.
 */
export function PhaseDivider({ status, startedAt, isOpen, onToggle }: PhaseDividerProps) {
	const formattedDate = formatPhaseDate(startedAt)
	const label = status.replace(/_/g, ' ')

	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={isOpen}
			className="relative z-[2] flex w-full cursor-pointer items-center gap-[9px] bg-background pb-2.5 pt-3.5 text-left"
		>
			<span className="shrink-0 font-mono text-[9.5px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
				{label}
			</span>
			{formattedDate && (
				<span className="shrink-0 text-[10.5px] text-border-strong">{formattedDate}</span>
			)}
			<span aria-hidden="true" className="h-px flex-1 bg-muted" />
		</button>
	)
}
