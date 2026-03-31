import type { Database } from '@ai-native/db'
import { events, objects, triggers } from '@ai-native/db/schema'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'
import { Cron } from 'croner'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { SessionManager } from './session-manager'

export class TriggerRunner {
	private db: Database
	private bridge: PgNotifyBridge
	private sessionManager: SessionManager
	private cronJobs: Map<string, Cron> = new Map()
	private reminderTimeouts: Map<string, NodeJS.Timeout> = new Map()
	private eventHandler: ((event: PgEvent) => void) | null = null

	constructor(db: Database, bridge: PgNotifyBridge, sessionManager: SessionManager) {
		this.db = db
		this.bridge = bridge
		this.sessionManager = sessionManager
	}

	async start() {
		// Start event trigger listener
		this.eventHandler = (event: PgEvent) => {
			this.handleEvent(event).catch((err) =>
				logger.error('Event handling failed', { error: String(err) }),
			)
		}
		this.bridge.on('event', this.eventHandler)

		// Load and start cron triggers
		await this.loadCronTriggers()

		// Load and schedule reminder triggers
		await this.loadReminders()

		logger.info('Trigger runner started')
	}

	async stop() {
		if (this.eventHandler) {
			this.bridge.off('event', this.eventHandler)
			this.eventHandler = null
		}
		for (const [_, job] of this.cronJobs) {
			job.stop()
		}
		this.cronJobs.clear()
		for (const [_, timeout] of this.reminderTimeouts) {
			clearTimeout(timeout)
		}
		this.reminderTimeouts.clear()
	}

	private async fetchEventData(eventId: string): Promise<Record<string, unknown> | null> {
		const [row] = await this.db
			.select({ data: events.data })
			.from(events)
			.where(eq(events.id, Number(eventId)))
		return (row?.data as Record<string, unknown>) ?? null
	}

	private async handleEvent(event: PgEvent) {
		// Hot-reload: react to trigger CRUD events
		if (event.entity_type === 'trigger') {
			await this.handleTriggerChange(event)
			return
		}

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

		// Lazily fetch event data from DB only when a trigger needs it (data is no longer in NOTIFY payload)
		let eventData: Record<string, unknown> | null | undefined
		const getEventData = async () => {
			if (eventData === undefined) {
				eventData = await this.fetchEventData(event.event_id)
			}
			return eventData
		}

		for (const trigger of matchingTriggers) {
			const config = trigger.config as Record<string, unknown>

			// Check if event matches trigger config
			if (config.entity_type && config.entity_type !== event.entity_type) continue
			if (config.action && config.action !== event.action) continue

			// Check filter conditions
			if (config.filter) {
				const data = await getEventData()
				if (!data) continue
				const filter = config.filter as Record<string, unknown>
				const matches = Object.entries(filter).every(([key, value]) => data[key] === value)
				if (!matches) continue
			}

			// Check status transition conditions
			if (config.from_status || config.to_status) {
				const data = await getEventData()
				const { previous, current } = getObjectFromData(data)
				if (config.from_status && previous?.status !== config.from_status) continue
				if (config.to_status && current?.status !== config.to_status) continue
			}

			// Check metadata conditions
			if (Array.isArray(config.conditions) && config.conditions.length > 0) {
				const data = await getEventData()
				const { current } = getObjectFromData(data)
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

	private async handleTriggerChange(event: PgEvent) {
		const triggerId = event.entity_id

		if (event.action === 'deleted') {
			this.cronJobs.get(triggerId)?.stop()
			this.cronJobs.delete(triggerId)
			const timeout = this.reminderTimeouts.get(triggerId)
			if (timeout) {
				clearTimeout(timeout)
				this.reminderTimeouts.delete(triggerId)
			}
			logger.info(`Trigger '${triggerId}' removed (deleted)`)
			return
		}

		// For created/updated: fetch current state and (re-)schedule
		const [trigger] = await this.db
			.select()
			.from(triggers)
			.where(eq(triggers.id, triggerId))
			.limit(1)

		if (!trigger) return

		// Stop any existing schedule first
		this.cronJobs.get(triggerId)?.stop()
		this.cronJobs.delete(triggerId)
		const timeout = this.reminderTimeouts.get(triggerId)
		if (timeout) {
			clearTimeout(timeout)
			this.reminderTimeouts.delete(triggerId)
		}

		if (!trigger.enabled) {
			logger.info(`Trigger '${trigger.name}' disabled, not scheduling`)
			return
		}

		if (trigger.type === 'cron') {
			this.scheduleCron(trigger)
		} else if (trigger.type === 'reminder') {
			this.scheduleReminder(trigger)
		}

		logger.info(
			`Trigger '${trigger.name}' ${event.action === 'created' ? 'scheduled' : 'rescheduled'}`,
		)
	}

	private async loadCronTriggers() {
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

		try {
			const job = new Cron(expression, async () => {
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
			})

			this.cronJobs.set(trigger.id, job)
		} catch (err) {
			logger.error(`Invalid cron expression '${expression}' for trigger '${trigger.name}'`, {
				triggerId: trigger.id,
				error: String(err),
			})
		}
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

export interface ObjectData {
	status?: string
	metadata?: Record<string, unknown>
}

export function getObjectFromData(data: Record<string, unknown> | null | undefined): {
	current?: ObjectData
	previous?: ObjectData
} {
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
