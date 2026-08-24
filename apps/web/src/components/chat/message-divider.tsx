import { startOfDay } from '@/lib/conversation-groups'

function formatDayLabel(date: Date): string {
	const now = new Date()
	const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
	if (diffDays === 0) return 'Today'
	if (diffDays === 1) return 'Yesterday'
	return date.toLocaleDateString(undefined, {
		month: 'long',
		day: 'numeric',
		...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
	})
}

/**
 * The hairline rule with a label floating between the two halves — the v2
 * shape for both a day boundary (`date`) and a system message (`label`,
 * mockup line 628). One component so the two never drift apart.
 */
export function MessageDivider({ date, label }: { date?: string | null; label?: string }) {
	const text = label ?? formatDayLabel(date ? new Date(date) : new Date())
	return (
		<div className="flex items-center gap-2.5 py-2">
			<div className="h-px flex-1 bg-border" />
			<span className="shrink-0 text-[10.5px] text-muted-foreground">{text}</span>
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
