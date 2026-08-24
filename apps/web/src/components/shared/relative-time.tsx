import { useEffect, useState } from 'react'

// Compact form — the mockup's list rows carry a 30px right-aligned age column
// ("2h", "1d", "4d"), so the unit stands alone with no "ago" suffix and dates
// older than a month collapse to a day/month token ("Jan 15") rather than a
// full locale date that would never fit.
function formatCompact(date: Date, dayLimit: number): string {
	const diff = Date.now() - date.getTime()
	const minutes = Math.floor(diff / 60_000)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)

	if (minutes < 1) return 'now'
	if (minutes < 60) return `${minutes}m`
	if (hours < 24) return `${hours}h`
	if (days < dayLimit) return `${days}d`
	return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function formatRelative(date: Date): string {
	const now = Date.now()
	const diff = now - date.getTime()
	const seconds = Math.floor(diff / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)

	if (seconds < 10) return 'now'
	if (seconds < 60) return `${seconds}s ago`
	if (minutes < 60) return `${minutes}m ago`
	if (hours < 24) return `${hours}h ago`
	if (days < 30) return `${days}d ago`
	return date.toLocaleDateString()
}

export function RelativeTime({
	date,
	className,
	compact = false,
	compactDayLimit = 30,
}: {
	date: string | null
	className?: string
	/** Age-column form: "2h" instead of "2h ago". */
	compact?: boolean
	/**
	 * How many days the compact form counts before collapsing to a date token.
	 * The For You feed cuts over at a week; the default suits list rows.
	 */
	compactDayLimit?: number
}) {
	const [, setTick] = useState(0)

	useEffect(() => {
		const interval = setInterval(() => setTick((t) => t + 1), 60_000)
		return () => clearInterval(interval)
	}, [])

	if (!date) return null

	return (
		<time className={className} dateTime={date} title={new Date(date).toLocaleString()}>
			{compact ? formatCompact(new Date(date), compactDayLimit) : formatRelative(new Date(date))}
		</time>
	)
}
