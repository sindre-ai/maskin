import { triggerKind } from './trigger-rows'

// Notes create_trigger and update_trigger send back next to the saved trigger.
// They never block the save: each one says what is likely wrong and what to do.

export type TriggerWarningCode =
	| 'similar_trigger_exists'
	| 'fixed_date_repeats_yearly'
	| 'event_without_filter'
	| 'no_stop_condition'

export interface TriggerWarning {
	code: TriggerWarningCode
	message: string
	/** The trigger the warning is about, when it is not the one just saved. */
	trigger_id?: string
}

interface TriggerShape {
	name: string
	type: string
	config: Record<string, unknown> | null
	actionPrompt?: string | null
}

export interface OtherTrigger extends TriggerShape {
	id: string
	enabled: boolean
}

export interface WarningChecks {
	/** Look at the prompt. Off for an update that did not touch it. */
	prompt: boolean
	/** Look at the schedule or event config. Off for an update that did not touch it. */
	config: boolean
	/** Look for a similar trigger. Off when the trigger was just disabled. */
	similar: boolean
}

const MAX_SIMILAR_WARNINGS = 3

// Words that say when a run is over or when to do nothing.
const STOP_WORDS =
	/\b(stop|stops|done when|finish|finished|until|disable|nothing to do|no more|no further|no new|exit|end the run|end this run|end the session|complete|completed)\b/i

/**
 * True for a cron whose day of month and month are both fixed ("0 9 10 11 *"),
 * which fires once a year. A plain day of month ("0 9 10 * *") is monthly and fine.
 */
export function isFixedDateCron(expression: string): boolean {
	const fields = expression.trim().split(/\s+/)
	if (fields.length !== 5 && fields.length !== 6) return false
	const [dayOfMonth, month] = fields.slice(-3)
	const fixed = /^[0-9A-Za-z]+(,[0-9A-Za-z]+)*$/
	return fixed.test(dayOfMonth ?? '') && fixed.test(month ?? '')
}

function cronExpression(trigger: Pick<TriggerShape, 'type' | 'config'>): string | null {
	const expression = trigger.config?.expression
	return trigger.type === 'cron' && typeof expression === 'string' ? expression : null
}

function isOneOff(trigger: Pick<TriggerShape, 'type' | 'config'>): boolean {
	if (trigger.type === 'reminder') return true
	const expression = cronExpression(trigger)
	return expression !== null && isFixedDateCron(expression)
}

function sortedJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b),
		)
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

function describeSimilar(subject: TriggerShape, other: OtherTrigger): string | null {
	if (other.name.trim().toLowerCase() === subject.name.trim().toLowerCase()) return 'same name'
	if (other.type === subject.type && sortedJson(other.config) === sortedJson(subject.config)) {
		return 'same schedule'
	}
	// A one-off next to a repeating run: the repeating one usually already covers it.
	if (isOneOff(subject) && cronExpression(other) !== null && !isOneOff(other)) {
		return 'already runs on a repeating schedule'
	}
	return null
}

/**
 * `others` are the agent's other enabled triggers (the saved one may be in the
 * list; it is skipped by id).
 */
export function detectTriggerWarnings(input: {
	id: string
	trigger: TriggerShape
	others: OtherTrigger[]
	checks: WarningChecks
}): TriggerWarning[] {
	const { id, trigger, others, checks } = input
	const warnings: TriggerWarning[] = []

	if (checks.similar) {
		const similar = others
			.filter((other) => other.id !== id && other.enabled)
			.map((other) => ({ other, why: describeSimilar(trigger, other) }))
			.filter((hit): hit is { other: OtherTrigger; why: string } => hit.why !== null)
			.slice(0, MAX_SIMILAR_WARNINGS)
		for (const { other, why } of similar) {
			warnings.push({
				code: 'similar_trigger_exists',
				trigger_id: other.id,
				message: `This agent already has an enabled ${triggerKind(other.type)} trigger "${other.name}" (${why}), id ${other.id}. Reuse it, or change it with update_trigger, instead of keeping two.`,
			})
		}
	}

	if (checks.config) {
		const expression = cronExpression(trigger)
		if (expression !== null && isFixedDateCron(expression)) {
			warnings.push({
				code: 'fixed_date_repeats_yearly',
				message: `"${expression}" is a fixed day and month, so it fires again every year and stays enabled. If it should run once, create it with run_at instead, which runs once and disables itself.`,
			})
		}
		if (trigger.type === 'event') {
			const config = trigger.config ?? {}
			const hasFilter = Object.keys((config.filter as object | undefined) ?? {}).length > 0
			const hasConditions = Array.isArray(config.conditions) && config.conditions.length > 0
			if (!hasFilter && !hasConditions && !config.from_status && !config.to_status) {
				warnings.push({
					code: 'event_without_filter',
					message: `This event trigger has no filter, so it fires on every ${String(config.action ?? 'change')} of ${String(config.entity_type ?? 'that type')}. Narrow it with config.filter, conditions or to_status if it should only fire on some.`,
				})
			}
		}
	}

	if (checks.prompt && !STOP_WORDS.test(trigger.actionPrompt ?? '')) {
		warnings.push({
			code: 'no_stop_condition',
			message:
				'The prompt does not say when to stop. Add what done looks like and when to do nothing and end the run, so each run stays short.',
		})
	}

	return warnings
}
