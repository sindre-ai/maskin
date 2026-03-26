import { useEffect, useReducer } from 'react'
import { formatDurationMs } from '@/lib/format-duration'

export function useDuration(startedAt: string | null | undefined): string | null {
	const [, tick] = useReducer((n: number) => n + 1, 0)

	useEffect(() => {
		if (!startedAt) return
		const interval = setInterval(tick, 30000)
		return () => clearInterval(interval)
	}, [startedAt])

	if (!startedAt) return null
	const ms = Date.now() - new Date(startedAt).getTime()
	return formatDurationMs(ms)
}
