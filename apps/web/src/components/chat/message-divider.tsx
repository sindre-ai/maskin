function formatDayLabel(date: Date): string {
	const now = new Date()
	const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
	const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
	if (diffDays === 0) return 'Today'
	if (diffDays === 1) return 'Yesterday'
	return date.toLocaleDateString(undefined, {
		month: 'long',
		day: 'numeric',
		...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
	})
}

export function MessageDivider({ date }: { date: string | null }) {
	return (
		<div className="flex items-center gap-3 py-2">
			<div className="h-px flex-1 bg-border" />
			<span className="shrink-0 text-xs font-medium text-muted-foreground">
				{formatDayLabel(date ? new Date(date) : new Date())}
			</span>
			<div className="h-px flex-1 bg-border" />
		</div>
	)
}

/** Returns true when `date` falls on a different calendar day than `prevDate`. */
export function isNewDay(date: string | null, prevDate: string | null): boolean {
	if (!prevDate || !date) return true
	const a = new Date(date)
	const b = new Date(prevDate)
	return (
		a.getFullYear() !== b.getFullYear() ||
		a.getMonth() !== b.getMonth() ||
		a.getDate() !== b.getDate()
	)
}
