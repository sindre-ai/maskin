import { useEffect, useState } from 'react'

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
}: {
	date: string | null
	className?: string
}) {
	const [, setTick] = useState(0)

	useEffect(() => {
		const interval = setInterval(() => setTick((t) => t + 1), 60_000)
		return () => clearInterval(interval)
	}, [])

	if (!date) return null

	return (
		<time className={className} dateTime={date} title={new Date(date).toLocaleString()}>
			{formatRelative(new Date(date))}
		</time>
	)
}
