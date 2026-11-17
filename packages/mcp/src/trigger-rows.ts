import { describeCronExpression, formatCopenhagenStamp } from '@maskin/shared'
import { Cron } from 'croner'

// What list_triggers, get_trigger, create_trigger and update_trigger show for a
// trigger. The API row carries the whole action prompt and config; an agent
// scanning 100 triggers needs the handful of fields below, and one line of
// what each is for.

/** The part of an API trigger row these helpers read. */
export interface TriggerRowSource {
	id: string
	name: string
	type: string
	config: Record<string, unknown> | null
	enabled: boolean
	targetActorId?: string | null
	actionPrompt?: string | null
	lastRunAt?: string | null
	url?: string
}

export type TriggerKind = 'recurring' | 'one-time' | 'event'

export interface CompactTrigger {
	id: string
	name: string
	status: 'enabled' | 'disabled'
	kind: TriggerKind
	schedule: string
	/** The stored cron, which the server reads in UTC. Only on recurring triggers. */
	cron?: string
	next_run: string | null
	last_run?: string | null
	agent: { id: string | null; name: string | null }
	purpose: string
	url?: string
}

const PURPOSE_MAX_CHARS = 140

export function triggerKind(type: string): TriggerKind {
	if (type === 'cron') return 'recurring'
	if (type === 'reminder') return 'one-time'
	return 'event'
}

/** The schedule as a person reads it, in Copenhagen time: a described cron, the run-at time, or the event. */
export function triggerSchedule(
	trigger: Pick<TriggerRowSource, 'type' | 'config'>,
	now = new Date(),
): string {
	const config = trigger.config ?? {}
	if (trigger.type === 'cron') {
		if (typeof config.expression !== 'string') return 'cron'
		// A cron this app does not generate (steps, lists, ranges) cannot be shown in
		// Copenhagen time, so it stays as written and says which clock it runs on.
		const described = describeCronExpression(config.expression, now)
		return described === config.expression ? `${config.expression} (UTC)` : described
	}
	if (trigger.type === 'reminder') {
		if (typeof config.scheduled_at !== 'string') return 'once'
		return `once at ${formatCopenhagenStamp(config.scheduled_at) ?? config.scheduled_at}`
	}
	const parts = [config.action, config.entity_type].filter((v) => typeof v === 'string')
	return parts.length ? `on ${parts.join(' ')}` : 'on event'
}

/** When it fires next, as an ISO string. Null for event triggers and disabled ones. */
export function triggerNextRun(
	trigger: Pick<TriggerRowSource, 'type' | 'config' | 'enabled'>,
	now = new Date(),
): string | null {
	if (!trigger.enabled) return null
	const config = trigger.config ?? {}
	if (trigger.type === 'reminder') {
		return typeof config.scheduled_at === 'string' ? config.scheduled_at : null
	}
	if (trigger.type === 'cron' && typeof config.expression === 'string') {
		try {
			return new Cron(config.expression, { timezone: 'UTC' }).nextRun(now)?.toISOString() ?? null
		} catch {
			return null
		}
	}
	return null
}

/** The first line of the prompt, cut to one short line. */
export function triggerPurpose(actionPrompt: string | null | undefined): string {
	const firstLine = (actionPrompt ?? '').split('\n').find((line) => line.trim().length > 0) ?? ''
	const line = firstLine.replace(/\s+/g, ' ').trim()
	return line.length > PURPOSE_MAX_CHARS ? `${line.slice(0, PURPOSE_MAX_CHARS - 1)}…` : line
}

export function compactTrigger(
	trigger: TriggerRowSource,
	agent: { id: string | null; name: string | null },
	now = new Date(),
): CompactTrigger {
	return {
		id: trigger.id,
		name: trigger.name,
		status: trigger.enabled ? 'enabled' : 'disabled',
		kind: triggerKind(trigger.type),
		schedule: triggerSchedule(trigger, now),
		...(trigger.type === 'cron' && typeof trigger.config?.expression === 'string'
			? { cron: trigger.config.expression }
			: {}),
		next_run: triggerNextRun(trigger, now),
		...(trigger.lastRunAt !== undefined ? { last_run: trigger.lastRunAt } : {}),
		agent,
		purpose: triggerPurpose(trigger.actionPrompt),
		...(trigger.url ? { url: trigger.url } : {}),
	}
}
