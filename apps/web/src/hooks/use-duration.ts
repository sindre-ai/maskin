import { useEffect, useState } from 'react'

export function useDuration(startedAt: string | null | undefined): string | null {
	const [now, setNow] = useState(Date.now())

	useEffect(() => {
		if (!startedAt) return
		const interval = setInterval(() => setNow(Date.now()), 30000)
		return () => clearInterval(interval)
	}, [startedAt])

	if (!startedAt) return null
	const ms = now - new Date(startedAt).getTime()
	if (ms < 60000) return '<1m'
	const minutes = Math.floor(ms / 60000)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${minutes % 60}m`
}
