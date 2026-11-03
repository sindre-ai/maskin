import type { TriggerResponse } from '@/lib/api'
import { nextCronFire } from '@/lib/cron'

/** The earliest instant strictly after `now` any of `triggers` will fire, or
 * `null` when no enabled cron/reminder trigger has a computable next fire. */
export function nextFireAt(triggers: TriggerResponse[], now: Date = new Date()): Date | null {
	let earliest: Date | null = null
	for (const trigger of triggers) {
		if (!trigger.enabled) continue
		const config = trigger.config as Record<string, unknown> | null
		if (!config) continue

		let candidate: Date | null = null
		if (trigger.type === 'cron' && typeof config.expression === 'string') {
			candidate = nextCronFire(config.expression, now)
		} else if (trigger.type === 'reminder' && typeof config.scheduled_at === 'string') {
			const parsed = new Date(config.scheduled_at)
			if (!Number.isNaN(parsed.getTime()) && parsed > now) candidate = parsed
		}
		if (!candidate) continue
		if (!earliest || candidate < earliest) earliest = candidate
	}
	return earliest
}

/** Compact tile label: `in 4m` / `in 3h` / `in 2d` / an absolute date for
 * anything a week or more out. Returns `null` when there's no next fire so the
 * caller renders the spec's em-dash empty state instead of a stale number. */
export function nextFireLabel(at: Date | null, now: Date = new Date()): string | null {
	if (!at) return null
	const ms = at.getTime() - now.getTime()
	if (ms <= 0) return null
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `in ${minutes}m`
	const hours = Math.round(ms / 3_600_000)
	if (hours < 24) return `in ${hours}h`
	const days = Math.round(ms / 86_400_000)
	if (days < 7) return `in ${days}d`
	return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
