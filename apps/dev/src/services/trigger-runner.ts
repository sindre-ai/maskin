import type { Database } from '@ai-native/db'
import { events, objects, triggers } from '@ai-native/db/schema'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { SessionManager } from './session-manager'

export class TriggerRunner {
	private db: Database
	private bridge: PgNotifyBridge
	private sessionManager: SessionManager
	private cronTimeouts: Map<string, NodeJS.Timeout> = new Map()
	private reminderTimeouts: Map<string, NodeJS.Timeout> = new Map()

	constructor(db: Database, bridge: PgNotifyBridge, sessionManager: SessionManager) {
		this.db = db
		this.bridge = bridge
		this.sessionManager = sessionManager
	}

	async start() {
		// Start event trigger listener
		this.bridge.on('event', (event: PgEvent) => {
			this.handleEvent(event).catch((err) =>
				logger.error('Event handling failed', { error: String(err) }),
			)
		})

		// Load and start cron triggers
		await this.loadCronTriggers()

		// Load and schedule reminder triggers
		await this.loadReminders()

		logger.info('Trigger runner started')
	}

	async stop() {
		for (const [_, timeout] of this.cronTimeouts) {
			clearTimeout(timeout)
		}
		this.cronTimeouts.clear()
		for (const [_, timeout] of this.reminderTimeouts) {
			clearTimeout(timeout)
		}
		this.reminderTimeouts.clear()
	}

	private async handleEvent(event: PgEvent) {
		// Find matching event triggers for this workspace
		const matchingTriggers = await this.db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, event.workspace_id),
					eq(triggers.type, 'event'),
					eq(triggers.enabled, true),
				),
			)

		for (const trigger of matchingTriggers) {
			const config = trigger.config as Record<string, unknown>

			// Check if event matches trigger config
			if (config.entity_type && config.entity_type !== event.entity_type) continue
			if (config.action && config.action !== event.action) continue

			// Check filter conditions
			if (config.filter && event.data) {
				const filter = config.filter as Record<string, unknown>
				const data = event.data as Record<string, unknown>
				const matches = Object.entries(filter).every(([key, value]) => data[key] === value)
				if (!matches) continue
			}

			// Check status transition conditions
			if (config.from_status || config.to_status) {
				const { previous, current } = getObjectFromEvent(event)
				if (config.from_status && previous?.status !== config.from_status) continue
				if (config.to_status && current?.status !== config.to_status) continue
			}

			// Check metadata conditions
			if (Array.isArray(config.conditions) && config.conditions.length > 0) {
				const { current } = getObjectFromEvent(event)
				if (!current || !evaluateConditions(config.conditions, current)) continue
			}

			// Run the agent
			logger.info(
				`Trigger '${trigger.name}' fired for event ${event.action} on ${event.entity_type}`,
			)

			// Log trigger fired event
			await this.db.insert(events).values({
				workspaceId: event.workspace_id,
				actorId: trigger.targetActorId,
				action: 'trigger_fired',
				entityType: 'trigger',
				entityId: trigger.id,
				data: {
					trigger_name: trigger.name,
					prompt: trigger.actionPrompt,
					target_actor_id: trigger.targetActorId,
					source_event: event,
				},
			})

			const prompt = `${trigger.actionPrompt}\n\nTriggering event: ${JSON.stringify(event)}`
			this.sessionManager
				.createSession(event.workspace_id, {
					actorId: trigger.targetActorId,
					actionPrompt: prompt,
					triggerId: trigger.id,
					createdBy: trigger.createdBy,
				})
				.then(async (session) => {
					// Link the object to the active session
					if (event.entity_id) {
						await this.db
							.update(objects)
							.set({ activeSessionId: session.id, updatedAt: new Date() })
							.where(eq(objects.id, event.entity_id))
							.catch((err) =>
								logger.debug('Could not link object to active session', {
									sessionId: session.id,
									entityId: event.entity_id,
									error: String(err),
								}),
							)
					}
				})
				.catch((err) => logger.error('Container session creation failed', { error: String(err) }))
		}
	}

	private async loadCronTriggers() {
		// Simple cron: parse expression to interval (MVP: only supports minute intervals)
		const cronTriggers = await this.db
			.select()
			.from(triggers)
			.where(and(eq(triggers.type, 'cron'), eq(triggers.enabled, true)))

		for (const trigger of cronTriggers) {
			this.scheduleCron(trigger)
		}
	}

	private scheduleCron(trigger: typeof triggers.$inferSelect) {
		const config = trigger.config as Record<string, unknown>
		const expression = config.expression as string

		const schedule = () => {
			const delay = getNextCronDelay(expression)
			if (delay === null) {
				logger.error(`Invalid cron expression for trigger '${trigger.name}', skipping`)
				return
			}

			const timeout = setTimeout(async () => {
				logger.info(`Cron trigger '${trigger.name}' firing`)

				await this.db.insert(events).values({
					workspaceId: trigger.workspaceId,
					actorId: trigger.targetActorId,
					action: 'trigger_fired',
					entityType: 'trigger',
					entityId: trigger.id,
					data: {
						trigger_name: trigger.name,
						prompt: trigger.actionPrompt,
						target_actor_id: trigger.targetActorId,
					},
				})

				this.sessionManager
					.createSession(trigger.workspaceId, {
						actorId: trigger.targetActorId,
						actionPrompt: trigger.actionPrompt,
						triggerId: trigger.id,
						createdBy: trigger.createdBy,
					})
					.catch((err) => logger.error('Container session creation failed', { error: String(err) }))

				// Schedule next run
				schedule()
			}, delay)

			this.cronTimeouts.set(trigger.id, timeout)
		}

		schedule()
	}

	private async loadReminders() {
		const reminderTriggers = await this.db
			.select()
			.from(triggers)
			.where(and(eq(triggers.type, 'reminder'), eq(triggers.enabled, true)))

		for (const trigger of reminderTriggers) {
			this.scheduleReminder(trigger)
		}
	}

	private scheduleReminder(trigger: typeof triggers.$inferSelect) {
		const config = trigger.config as Record<string, unknown>
		const scheduledAt = new Date(config.scheduled_at as string)
		const delay = Math.max(0, scheduledAt.getTime() - Date.now())

		const timeout = setTimeout(async () => {
			logger.info(`Reminder trigger '${trigger.name}' firing`)

			await this.db.insert(events).values({
				workspaceId: trigger.workspaceId,
				actorId: trigger.targetActorId,
				action: 'trigger_fired',
				entityType: 'trigger',
				entityId: trigger.id,
				data: {
					trigger_name: trigger.name,
					prompt: trigger.actionPrompt,
					target_actor_id: trigger.targetActorId,
					scheduled_at: config.scheduled_at,
				},
			})

			this.sessionManager
				.createSession(trigger.workspaceId, {
					actorId: trigger.targetActorId,
					actionPrompt: trigger.actionPrompt,
					triggerId: trigger.id,
					createdBy: trigger.createdBy,
				})
				.catch((err) => logger.error('Container session creation failed', { error: String(err) }))

			// Auto-disable after firing
			await this.db
				.update(triggers)
				.set({ enabled: false, updatedAt: new Date() })
				.where(eq(triggers.id, trigger.id))

			this.reminderTimeouts.delete(trigger.id)
		}, delay)

		this.reminderTimeouts.set(trigger.id, timeout)
	}
}

// Parse a single cron field into a set of matching values.
// Supports: wildcard, step, literal, range, list, and combinations.
export function parseCronField(field: string, min: number, max: number): Set<number> | null {
	const values = new Set<number>()
	for (const part of field.split(',')) {
		const stepMatch = part.match(/^(\d+)-(\d+)\/(\d+)$/)
		if (stepMatch) {
			const [, start, end, step] = stepMatch
			const s = Number(start)
			const e = Number(end)
			const st = Number(step)
			if (s < min || e > max || st <= 0) return null
			for (let i = s; i <= e; i += st) values.add(i)
			continue
		}
		const wildStep = part.match(/^\*\/(\d+)$/)
		if (wildStep) {
			const step = Number(wildStep[1])
			if (step <= 0) return null
			for (let i = min; i <= max; i += step) values.add(i)
			continue
		}
		if (part === '*') {
			for (let i = min; i <= max; i++) values.add(i)
			continue
		}
		const rangeMatch = part.match(/^(\d+)-(\d+)$/)
		if (rangeMatch) {
			const s = Number(rangeMatch[1])
			const e = Number(rangeMatch[2])
			if (s < min || e > max || s > e) return null
			for (let i = s; i <= e; i++) values.add(i)
			continue
		}
		const num = Number(part)
		if (Number.isNaN(num) || num < min || num > max) return null
		values.add(num)
	}
	return values.size > 0 ? values : null
}

/**
 * Calculate ms until the next time a 5-field cron expression matches.
 * Returns null if the expression is invalid.
 * Scans up to 366 days ahead to find a match (covers leap years + all month/dow combos).
 */
export function getNextCronDelay(expression: string, now?: Date): number | null {
	const parts = expression.trim().split(/\s+/)
	if (parts.length !== 5) return null
	const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string]

	const minutes = parseCronField(minF, 0, 59)
	const hours = parseCronField(hourF, 0, 23)
	const daysOfMonth = parseCronField(domF, 1, 31)
	const months = parseCronField(monF, 1, 12)
	const daysOfWeek = parseCronField(dowF, 0, 6)

	if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null

	const current = now ?? new Date()
	// Start from the next minute boundary
	const candidate = new Date(current)
	candidate.setSeconds(0, 0)
	candidate.setMinutes(candidate.getMinutes() + 1)

	// Scan up to 366 days * 24 hours * 60 minutes = 527040 minutes
	const maxMinutes = 366 * 24 * 60
	for (let i = 0; i < maxMinutes; i++) {
		if (
			months.has(candidate.getMonth() + 1) &&
			daysOfMonth.has(candidate.getDate()) &&
			daysOfWeek.has(candidate.getDay()) &&
			hours.has(candidate.getHours()) &&
			minutes.has(candidate.getMinutes())
		) {
			return candidate.getTime() - current.getTime()
		}
		candidate.setMinutes(candidate.getMinutes() + 1)
	}

	return null
}

export interface ObjectData {
	status?: string
	metadata?: Record<string, unknown>
}

export function getObjectFromEvent(event: PgEvent): {
	current?: ObjectData
	previous?: ObjectData
} {
	const data = event.data as Record<string, unknown> | undefined
	if (!data) return {}

	// updated / status_changed events have { previous, updated }
	if (data.previous && data.updated) {
		return {
			current: data.updated as ObjectData,
			previous: data.previous as ObjectData,
		}
	}

	// created events have the full object directly
	return { current: data as ObjectData }
}

export interface TriggerCondition {
	field: string
	operator: string
	value?: unknown
}

export function evaluateConditions(conditions: TriggerCondition[], obj: ObjectData): boolean {
	return conditions.every((c) => evaluateCondition(c, obj))
}

export function evaluateCondition(condition: TriggerCondition, obj: ObjectData): boolean {
	const metadata = obj.metadata ?? {}
	const fieldValue = metadata[condition.field]
	const condValue = condition.value

	switch (condition.operator) {
		case 'is_set':
			return fieldValue !== null && fieldValue !== undefined
		case 'is_not_set':
			return fieldValue === null || fieldValue === undefined
		case 'equals':
			// biome-ignore lint/suspicious/noDoubleEquals: loose comparison for number/string coercion
			return fieldValue == condValue
		case 'not_equals':
			// biome-ignore lint/suspicious/noDoubleEquals: loose comparison for number/string coercion
			return fieldValue != condValue
		case 'greater_than':
			return Number(fieldValue) > Number(condValue)
		case 'less_than':
			return Number(fieldValue) < Number(condValue)
		case 'before': {
			const d = new Date(String(fieldValue))
			const t = new Date(String(condValue))
			return !Number.isNaN(d.getTime()) && !Number.isNaN(t.getTime()) && d < t
		}
		case 'after': {
			const d = new Date(String(fieldValue))
			const t = new Date(String(condValue))
			return !Number.isNaN(d.getTime()) && !Number.isNaN(t.getTime()) && d > t
		}
		case 'within_days': {
			const d = new Date(String(fieldValue))
			if (Number.isNaN(d.getTime())) return false
			const days = Number(condValue)
			if (Number.isNaN(days)) return false
			const diff = d.getTime() - Date.now()
			return diff >= 0 && diff <= days * 86_400_000
		}
		case 'contains':
			if (Array.isArray(fieldValue)) {
				return fieldValue.includes(condValue)
			}
			return String(fieldValue ?? '').includes(String(condValue ?? ''))
		default:
			return false
	}
}
