import type { Database } from '@maskin/db'
import { events, objects, sessions, triggers } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { SAFE_METADATA_FIELD_NAME_RE, readChanges, reversePatch } from '@maskin/shared'
import { Cron } from 'croner'
import { type SQL, and, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { SessionManager } from './session-manager'

/** Cap on scope-match rows appended to the action prompt so the payload stays bounded. */
const SCOPE_MATCH_LIMIT = 100

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight'])

interface TriggerFailureState {
	count: number
	lastFailedAt: Date
	backoffUntil: Date
}

/** Maximum backoff duration: 30 minutes */
const MAX_BACKOFF_MS = 30 * 60_000
/** Base backoff duration: 1 minute */
const BASE_BACKOFF_MS = 60_000

export function calculateBackoffUntil(failureCount: number, now: Date): Date {
	const delayMs = Math.min(2 ** failureCount * BASE_BACKOFF_MS, MAX_BACKOFF_MS)
	return new Date(now.getTime() + delayMs)
}

export class TriggerRunner {
	private db: Database
	private bridge: PgNotifyBridge
	private sessionManager: SessionManager
	private cronJobs: Map<string, Cron> = new Map()
	private reminderTimeouts: Map<string, NodeJS.Timeout> = new Map()
	private eventHandler: ((event: PgEvent) => void) | null = null
	private sessionEventHandler: ((event: PgEvent) => void) | null = null
	private triggerFailures: Map<string, TriggerFailureState> = new Map()
	// A session's terminal outcome can be reported more than once: e.g.
	// SessionManager.stopSession() writes a provisional session_failed row,
	// and the agent-server's own genuine completion report — if it arrives,
	// which is the normal case, not a rare race — overwrites it with the real
	// exit code (see markRemoteSessionComplete's stoppedByUser handling in
	// session-manager.ts). Both writes insert their own session_failed/
	// session_completed events row for audit-trail visibility, but they
	// represent ONE physical session outcome. This map ensures only the first
	// terminal event for a given session counts toward its trigger's
	// failure/backoff accounting — otherwise every explicit stop of a
	// trigger-spawned session double-counts as two failures instead of one.
	private processedSessionOutcomes: Map<string, NodeJS.Timeout> = new Map()
	private static readonly SESSION_OUTCOME_DEDUPE_TTL_MS = 10 * 60_000

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

		// Listen for session completion/failure events for backoff tracking
		this.sessionEventHandler = (event: PgEvent) => {
			if (
				event.entity_type === 'session' &&
				(event.action === 'session_completed' ||
					event.action === 'session_failed' ||
					event.action === 'session_timeout')
			) {
				this.handleSessionOutcome(event).catch((err) =>
					logger.error('Session outcome handling failed', { error: String(err) }),
				)
			}
		}
		this.bridge.on('event', this.sessionEventHandler)

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
		if (this.sessionEventHandler) {
			this.bridge.off('event', this.sessionEventHandler)
			this.sessionEventHandler = null
		}
		for (const [_, job] of this.cronJobs) {
			job.stop()
		}
		this.cronJobs.clear()
		for (const [_, timeout] of this.reminderTimeouts) {
			clearTimeout(timeout)
		}
		this.reminderTimeouts.clear()
		for (const [_, timeout] of this.processedSessionOutcomes) {
			clearTimeout(timeout)
		}
		this.processedSessionOutcomes.clear()
	}

	private recordTriggerFailure(triggerId: string): void {
		const now = new Date()
		const existing = this.triggerFailures.get(triggerId)
		const count = (existing?.count ?? 0) + 1
		const backoffUntil = calculateBackoffUntil(count, now)
		this.triggerFailures.set(triggerId, {
			count,
			lastFailedAt: now,
			backoffUntil,
		})
		logger.warn(
			`Trigger '${triggerId}' failure #${count}, in backoff until ${backoffUntil.toISOString()}`,
		)
	}

	private resetTriggerBackoff(triggerId: string): void {
		if (this.triggerFailures.has(triggerId)) {
			logger.info(`Trigger '${triggerId}' backoff reset after successful session`)
			this.triggerFailures.delete(triggerId)
		}
	}

	private async handleSessionOutcome(event: PgEvent): Promise<void> {
		const sessionId = event.entity_id
		// Dedupe before any `await` so two events for the same session arriving
		// back-to-back can't both pass this check — see processedSessionOutcomes'
		// field comment above. A stale entry expires after
		// SESSION_OUTCOME_DEDUPE_TTL_MS, well past how long a genuine correction
		// report can realistically lag the provisional stop write.
		if (this.processedSessionOutcomes.has(sessionId)) return
		const dedupeTimeout = setTimeout(() => {
			this.processedSessionOutcomes.delete(sessionId)
		}, TriggerRunner.SESSION_OUTCOME_DEDUPE_TTL_MS)
		dedupeTimeout.unref?.()
		this.processedSessionOutcomes.set(sessionId, dedupeTimeout)

		// Look up the session to find which trigger spawned it
		const [session] = await this.db
			.select({ triggerId: sessions.triggerId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session?.triggerId) return

		if (event.action === 'session_completed') {
			this.resetTriggerBackoff(session.triggerId)
		} else {
			// session_failed or session_timeout
			this.recordTriggerFailure(session.triggerId)
		}
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

		// Lazily resolve {current, previous} for object entity events. New-shape events
		// (`data.changes`) don't carry the full pre/post snapshots, so we hydrate `current`
		// from the objects table and reconstruct `previous` by reversing the recorded diff.
		let objectContext: { current?: ObjectData; previous?: ObjectData } | undefined
		const resolveObjectContext = async (): Promise<{
			current?: ObjectData
			previous?: ObjectData
		}> => {
			const data = await getEventData()
			if (!data) return {}
			// Legacy `{previous, updated}` snapshot ships both sides intact.
			if (data.previous && data.updated) {
				return {
					current: data.updated as ObjectData,
					previous: data.previous as ObjectData,
				}
			}
			// New `{changes}` shape ships only the diff — hydrate current from the objects
			// table for object entities and reverse-patch to reconstruct previous.
			const changes = readChanges(data)
			if (!changes || !event.entity_id || !OBJECT_ENTITY_TYPES.has(event.entity_type)) return {}
			const [row] = await this.db
				.select()
				.from(objects)
				.where(eq(objects.id, event.entity_id))
				.limit(1)
			if (!row) return {}
			const current = row as unknown as ObjectData
			const previous = reversePatch(
				current as unknown as Record<string, unknown>,
				changes,
			) as unknown as ObjectData
			return { current, previous }
		}
		const getObjectContext = async () => {
			if (objectContext === undefined) objectContext = await resolveObjectContext()
			return objectContext
		}

		for (const trigger of matchingTriggers) {
			const config = trigger.config as Record<string, unknown>

			// Check if event matches trigger config
			// slack.message is a catch-all that matches any slack message subtype
			if (config.entity_type && config.entity_type !== event.entity_type) {
				if (
					config.entity_type !== 'slack.message' ||
					!event.entity_type.startsWith('slack.') ||
					!event.entity_type.endsWith('_message')
				) {
					continue
				}
			}
			if (config.action && config.action !== event.action) continue

			// Check filter conditions — for status_changed / updated events the entity lives
			// on `data.updated` (legacy) or must be hydrated from the objects table (new
			// {changes} shape). Use getObjectContext() + resolvePath() so dotted paths
			// (e.g. "metadata.decision_type") also work correctly.
			if (config.filter) {
				const data = await getEventData()
				if (!data) continue
				const isObjectUpdate =
					(event.action === 'updated' || event.action === 'status_changed') &&
					OBJECT_ENTITY_TYPES.has(event.entity_type)
				const ctx = isObjectUpdate ? await getObjectContext() : {}
				const filterRoot = (ctx.current ?? data) as Record<string, unknown>
				const filter = config.filter as Record<string, unknown>
				const matches = Object.entries(filter).every(
					([key, value]) => resolvePath(filterRoot, key) === value,
				)
				if (!matches) continue
			}

			// Check status transition conditions
			if (config.from_status || config.to_status) {
				const { previous, current } = await getObjectContext()
				if (config.from_status && previous?.status !== config.from_status) continue
				if (config.to_status && current?.status !== config.to_status) continue
			}

			// Check conditions — resolves against the full event payload with a `metadata`
			// fallback for legacy internal-object triggers. For updated/status_changed events
			// the "current" object (i.e. NEW.updated) is the natural root.
			if (Array.isArray(config.conditions) && config.conditions.length > 0) {
				const data = await getEventData()
				if (!data) continue
				const isObjectUpdate =
					(event.action === 'updated' || event.action === 'status_changed') &&
					OBJECT_ENTITY_TYPES.has(event.entity_type)
				const ctx = isObjectUpdate ? await getObjectContext() : {}
				const conditionRoot = (ctx.current ?? data) as Record<string, unknown>
				if (!evaluateConditions(config.conditions, conditionRoot)) continue
			}

			// Check backoff before firing
			const backoffState = this.triggerFailures.get(trigger.id)
			if (backoffState && backoffState.backoffUntil > new Date()) {
				logger.info(
					`Trigger '${trigger.name}' in backoff until ${backoffState.backoffUntil.toISOString()}, skipping`,
				)
				continue
			}

			// Run the agent
			logger.info(
				`Trigger '${trigger.name}' fired for event ${event.action} on ${event.entity_type}`,
			)

			// Enrich the event payload with the `data` column (stripped from NOTIFY for the 8KB
			// limit) so the agent can act directly on integration IDs like Gmail threadId / messageId
			// without round-tripping through get_events.
			const dataForPrompt = await getEventData()
			const eventForPrompt = { ...event, data: dataForPrompt ?? null }

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

			const prompt = `${trigger.actionPrompt}\n\nTriggering event: ${JSON.stringify(eventForPrompt)}`
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
			this.triggerFailures.delete(triggerId)
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

		// Clear backoff state when a trigger is updated/re-enabled
		this.resetTriggerBackoff(triggerId)

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
			const job = new Cron(expression, { timezone: 'UTC' }, async () => {
				await this.fireCronTrigger(trigger)
			})

			this.cronJobs.set(trigger.id, job)
		} catch (err) {
			logger.error(`Invalid cron expression for trigger '${trigger.name}': ${expression}`, {
				triggerId: trigger.id,
				error: String(err),
			})
		}
	}

	private async fireCronTrigger(trigger: typeof triggers.$inferSelect): Promise<void> {
		const cronBackoff = this.triggerFailures.get(trigger.id)
		if (cronBackoff && cronBackoff.backoffUntil > new Date()) {
			logger.info(
				`Cron trigger '${trigger.name}' in backoff until ${cronBackoff.backoffUntil.toISOString()}, skipping`,
			)
			return
		}

		const config = (trigger.config as Record<string, unknown>) ?? {}
		const scope = parseCronScope(config.scope)

		// When a scope filter is present, the trigger only fires if the query
		// matches at least one row. Zero rows → no session, no `trigger_fired`
		// event. This satisfies the "does not spawn an empty session" contract
		// at the runner level, not via a silent agent exit.
		let scopeMatches: { id: string; title: string | null }[] | null = null
		if (scope) {
			scopeMatches = await this.queryScopeMatches(trigger.workspaceId, scope)
			if (scopeMatches.length === 0) {
				logger.info(
					`Cron trigger '${trigger.name}' skipped — scope matched 0 rows in workspace ${trigger.workspaceId}`,
				)
				return
			}
		}

		logger.info(`Cron trigger '${trigger.name}' firing`)

		const eventData: Record<string, unknown> = {
			trigger_name: trigger.name,
			prompt: trigger.actionPrompt,
			target_actor_id: trigger.targetActorId,
		}
		if (scopeMatches) eventData.scope_matches = scopeMatches

		await this.db.insert(events).values({
			workspaceId: trigger.workspaceId,
			actorId: trigger.targetActorId,
			action: 'trigger_fired',
			entityType: 'trigger',
			entityId: trigger.id,
			data: eventData,
		})

		const actionPrompt = scopeMatches
			? `${trigger.actionPrompt}\n\nScope matches: ${JSON.stringify(scopeMatches)}`
			: trigger.actionPrompt

		this.sessionManager
			.createSession(trigger.workspaceId, {
				actorId: trigger.targetActorId,
				actionPrompt,
				triggerId: trigger.id,
				createdBy: trigger.createdBy,
			})
			.catch((err) => logger.error('Container session creation failed', { error: String(err) }))
	}

	private async queryScopeMatches(
		workspaceId: string,
		scope: CronScope,
	): Promise<{ id: string; title: string | null }[]> {
		return await queryCronScopeMatches(this.db, workspaceId, scope, SCOPE_MATCH_LIMIT)
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

export interface CronScope {
	entity_type: string
	metadata_eq?: Record<string, string>
	metadata_before_now?: string
}

/**
 * Query `objects` for the rows matching a cron trigger scope filter, scoped
 * to the trigger's workspace. Exported so integration tests can exercise the
 * JSONB metadata predicates and `timestamptz` cast against real Postgres —
 * mocked-DB unit tests can't catch a mis-cast or a JSONB coercion pitfall.
 */
export async function queryCronScopeMatches(
	db: Database,
	workspaceId: string,
	scope: CronScope,
	limit: number,
): Promise<{ id: string; title: string | null }[]> {
	const conditions: SQL[] = [
		eq(objects.workspaceId, workspaceId),
		eq(objects.type, scope.entity_type),
	]
	if (scope.metadata_eq) {
		for (const [key, value] of Object.entries(scope.metadata_eq)) {
			// Field name pre-validated by schema; guard against a hand-crafted
			// DB row that bypassed validation before inlining via sql.raw.
			if (!SAFE_METADATA_FIELD_NAME_RE.test(key)) continue
			conditions.push(sql`${objects.metadata}->>${sql.raw(`'${key}'`)} = ${value}`)
		}
	}
	if (scope.metadata_before_now) {
		const field = scope.metadata_before_now
		if (SAFE_METADATA_FIELD_NAME_RE.test(field)) {
			conditions.push(sql`(${objects.metadata}->>${sql.raw(`'${field}'`)})::timestamptz < now()`)
		}
	}
	return await db
		.select({ id: objects.id, title: objects.title })
		.from(objects)
		.where(and(...conditions))
		.limit(limit)
}

/**
 * Parse the `scope` block off a cron trigger config. Rejects anything that
 * isn't a plain object with an `entity_type` string plus optional
 * `metadata_eq` / `metadata_before_now`. Field names are pinned to
 * `SAFE_METADATA_FIELD_NAME_RE` so a hand-crafted DB row that skipped Zod
 * validation can never leak into the `sql.raw` path.
 */
export function parseCronScope(raw: unknown): CronScope | null {
	if (!raw || typeof raw !== 'object') return null
	const s = raw as Record<string, unknown>
	if (typeof s.entity_type !== 'string' || s.entity_type.length === 0) return null
	const scope: CronScope = { entity_type: s.entity_type }
	if (s.metadata_eq && typeof s.metadata_eq === 'object') {
		const eq: Record<string, string> = {}
		for (const [k, v] of Object.entries(s.metadata_eq as Record<string, unknown>)) {
			if (SAFE_METADATA_FIELD_NAME_RE.test(k) && typeof v === 'string') eq[k] = v
		}
		if (Object.keys(eq).length > 0) scope.metadata_eq = eq
	}
	if (
		typeof s.metadata_before_now === 'string' &&
		SAFE_METADATA_FIELD_NAME_RE.test(s.metadata_before_now)
	) {
		scope.metadata_before_now = s.metadata_before_now
	}
	return scope
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

/**
 * Resolve a dotted field path against a record. Returns undefined if any step is missing.
 * Example: resolvePath({ event: { channel: 'C1' } }, 'event.channel') === 'C1'
 */
export function resolvePath(
	root: Record<string, unknown> | null | undefined,
	path: string,
): unknown {
	if (!root) return undefined
	const parts = path.split('.')
	let cur: unknown = root
	for (const part of parts) {
		if (cur === null || cur === undefined) return undefined
		if (typeof cur !== 'object') return undefined
		cur = (cur as Record<string, unknown>)[part]
	}
	return cur
}

/**
 * Resolve a condition field against the data root. Tries the literal/dotted path first;
 * if it doesn't resolve, falls back to `root.metadata[field]` so existing internal-object
 * triggers (which assumed an implicit metadata lookup) keep working.
 */
function resolveConditionField(
	root: Record<string, unknown> | null | undefined,
	field: string,
): unknown {
	const direct = resolvePath(root, field)
	if (direct !== undefined) return direct
	if (root && typeof root === 'object' && 'metadata' in root) {
		const metadata = (root as { metadata?: Record<string, unknown> }).metadata
		if (metadata && typeof metadata === 'object') {
			return metadata[field]
		}
	}
	return undefined
}

export function evaluateConditions(
	conditions: TriggerCondition[],
	data: Record<string, unknown> | null | undefined,
): boolean {
	return conditions.every((c) => evaluateCondition(c, data))
}

export function evaluateCondition(
	condition: TriggerCondition,
	data: Record<string, unknown> | null | undefined,
): boolean {
	const fieldValue = resolveConditionField(data, condition.field)
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
		case 'in': {
			if (!Array.isArray(condValue)) return false
			if (fieldValue === null || fieldValue === undefined) return false
			return condValue.includes(fieldValue)
		}
		case 'not_in': {
			if (!Array.isArray(condValue)) return true
			if (fieldValue === null || fieldValue === undefined) return true
			return !condValue.includes(fieldValue)
		}
		default:
			return false
	}
}
