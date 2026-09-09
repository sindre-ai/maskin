import type { Database } from '@maskin/db'
import { events, actors, objects, sessions, triggers } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { SAFE_METADATA_FIELD_NAME_RE, readChanges, reversePatch } from '@maskin/shared'
import { Cron } from 'croner'
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm'
import {
	type CommentResponderCase,
	trackCommentResponderResolved,
} from '../lib/analytics/comment-responder-events'
import { LlmCredentialsUnavailableError, PlanCapExceededError } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { insertNotificationsWithEvents } from '../lib/notifications'
import type { SessionManager } from './session-manager'

/** Cap on scope-match rows appended to the action prompt so the payload stays bounded. */
const SCOPE_MATCH_LIMIT = 100

/**
 * Guards the objects-table hydration lookup: `objects.id` is a uuid column, so
 * probing it with a non-UUID entity id (e.g. a slack channel key) would raise
 * a Postgres "invalid input syntax for type uuid" error instead of just
 * finding no row. Which entity types are objects is deliberately NOT
 * hardcoded — workspaces define their own object types (extensions,
 * create_extension), so we attempt hydration for any UUID entity id and let a
 * missing row mean "not an object". A previous allow-list here
 * (['bet','task','insight']) silently broke status filters for custom-typed
 * objects flowing through loops.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Workspace Chief of Staff — the actor of last resort for case 3 dispatch when
 * a commented object has no driver (or the only candidate driver is the
 * comment author). Load-bearing per spec — see
 * `always-a-responder-rule-shaping.md` §Solution sketch case 3.
 */
const CHIEF_OF_STAFF_ACTOR_ID = '2e772113-48d0-410d-82e6-2414881581fc'

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

/**
 * A workspace-wide pause on spawning trigger sessions, set when starting a
 * session fails for a reason that is a property of the WORKSPACE rather than of
 * the individual trigger — an exhausted plan cap, or no LLM credentials at all.
 *
 * Why this exists: the per-trigger backoff above (`triggerFailures`) is driven
 * by session *outcome* events, and a plan cap is checked inside `createSession`
 * BEFORE a session row exists. No session row means no `session_failed` event,
 * which means `recordTriggerFailure` never runs and the backoff gate never
 * engages — so an over-cap workspace re-fired every one of its cron triggers,
 * at full rate, forever: ~372 identical failures a day from a single trial
 * workspace (Sentry MASKIN-DEV-K).
 *
 * The credentials case reaches this map by TWO routes, because the two
 * session-start paths report it differently:
 *
 *  - Local Docker (`launchContainer`) throws, so it arrives through
 *    `handleSessionCreateFailure` like the plan cap does.
 *  - Production (`SessionDispatchQueue` → `SessionDispatcher`) *returns* the
 *    failure as a value, and `SessionManager` has already returned by then, so
 *    nothing rejects here at all. That path arrives through
 *    `handleDispatchPermanentFailure`, wired as the queue's `onPermanentFailure`
 *    in `index.ts`. Without it this suppression would be inert in production
 *    for exactly the workspace it was written for — ~82/day from one enterprise
 *    workspace with no credentials connected (MASKIN-DEV-6).
 *
 * Deliberately NOT implemented as `triggers.enabled = false`: that is lossy.
 * Once flipped we cannot tell "Maskin paused this for billing" apart from "the
 * user turned it off", so a workspace that later upgrades would find its
 * automations silently still off with no safe way to restore them. This map is
 * advisory, expires on its own, and never mutates user intent.
 */
interface WorkspaceSuppression {
	/** Firing resumes on its own once `now >= until`. */
	until: Date
	reason: string
}

/**
 * Fallback pause for a cap with no known reset time. `PlanCapExceededError`
 * normally carries `periodEnd` (Stripe's `current_period_end`), but it is
 * nullable — a workspace whose Stripe webhook has not landed yet has no period
 * at all. One hour keeps a capped workspace quiet without stranding it for a
 * whole billing cycle on missing metadata.
 */
const PLAN_CAP_FALLBACK_SUPPRESSION_MS = 60 * 60_000

/**
 * Pause for "this workspace has no LLM credentials". Unlike a plan cap this has
 * no natural expiry — nothing resets it but a human connecting a credential —
 * so we re-check hourly rather than never, and clear the entry outright on an
 * entitlement-improving workspace event (see `SUPPRESSION_CLEARING_ACTIONS`).
 *
 * Caveat, deliberately stated rather than implied: importing a Claude
 * subscription via Settings → Keys does NOT currently clear the pause, because
 * `routes/claude-oauth.ts` writes `workspaces.settings` without inserting any
 * `events` row at all — so there is no event to match. That is a pre-existing
 * gap against the "log an event on every mutation" rule, not something this
 * pause introduced; until it is fixed, that recovery waits out the hour below.
 */
const NO_CREDENTIALS_SUPPRESSION_MS = 60 * 60_000

/**
 * Workspace-event actions that mean "this workspace's entitlement may have
 * IMPROVED", and so should lift an active pause early (see `handleEvent`).
 *
 * This is an allowlist rather than a bare `entity_type === 'workspace'` check
 * because the failure paths emit workspace events too — and one of them emits
 * on the very path that sets the pause. `resolveClaudeCredentialsWithFailover`
 * inserts `claude_subscription_failover_triggered` while failing over
 * (`claude-failover.ts` `recordFailoverTransition`), and the same resolution
 * then raises `LlmCredentialsUnavailableError` → `not_logged_in` →
 * `handleDispatchPermanentFailure` → a pause. PG NOTIFY is asynchronous, so
 * that event routinely lands AFTER the pause is set and would delete it —
 * suppress, clear, re-fire, fail, repeat, reproducing the very flood this
 * exists to stop, while logging "suppression cleared — workspace updated" as
 * if a human had fixed something.
 *
 * It is equally NOT a bare `action === 'updated'` check: the two most important
 * resume signals for a plan cap are not spelled `updated`. A plan upgrade
 * arrives as `workspace_billing_updated` and a credit purchase as
 * `workspace_credit_topup` (both `routes/stripe-webhook.ts`), and a top-up
 * genuinely un-caps the workspace via `canUseCreditBalance`. Filtering to
 * `updated` alone would strand an upgrading customer for the rest of the pause
 * — up to a full billing period.
 *
 * Deliberately excluded: `workspace_billing_canceled` (`routes/billing.ts`) is
 * a downgrade, and the two failover actions above are failures, not fixes.
 */
const SUPPRESSION_CLEARING_ACTIONS = new Set([
	// routes/workspaces.ts — settings PATCH, incl. custom_llm and LLM keys.
	'updated',
	// routes/stripe-webhook.ts — plan change/renewal, and prepaid credit added.
	'workspace_billing_updated',
	'workspace_credit_topup',
	// lib/claude-oauth-recovery.ts — primary subscription probed healthy again.
	'claude_subscription_recovered',
])

export class TriggerRunner {
	private db: Database
	private bridge: PgNotifyBridge
	private sessionManager: SessionManager
	private cronJobs: Map<string, Cron> = new Map()
	private reminderTimeouts: Map<string, NodeJS.Timeout> = new Map()
	private eventHandler: ((event: PgEvent) => void) | null = null
	private sessionEventHandler: ((event: PgEvent) => void) | null = null
	private triggerFailures: Map<string, TriggerFailureState> = new Map()
	/** workspaceId -> active workspace-wide pause. See `WorkspaceSuppression`. */
	private workspaceSuppressions: Map<string, WorkspaceSuppression> = new Map()
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
		this.workspaceSuppressions.clear()
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

	/**
	 * True when this workspace is inside an active pause. Expired entries are
	 * dropped on read, which is what makes firing resume with no timer, no
	 * background sweep, and no restart.
	 */
	private isWorkspaceSuppressed(workspaceId: string, triggerName?: string): boolean {
		const suppression = this.workspaceSuppressions.get(workspaceId)
		if (!suppression) return false
		if (suppression.until <= new Date()) {
			this.workspaceSuppressions.delete(workspaceId)
			logger.info(`Workspace ${workspaceId} trigger suppression expired — resuming`)
			return false
		}
		// debug, not info: this is the hot path once a pause is active — it runs
		// on every scheduled tick of every trigger in the workspace, and logging
		// it at info would reproduce at the log layer exactly the flood this
		// suppression exists to stop.
		logger.debug(
			`Trigger${triggerName ? ` '${triggerName}'` : ''} skipped — workspace ${workspaceId} suppressed until ${suppression.until.toISOString()} (${suppression.reason})`,
		)
		return true
	}

	/**
	 * Lifts a pause early. Called when a workspace is updated, so upgrading a
	 * plan or connecting a Claude subscription resumes automations on the next
	 * tick instead of after the pause runs out.
	 */
	private clearWorkspaceSuppression(workspaceId: string): void {
		if (this.workspaceSuppressions.delete(workspaceId)) {
			logger.info(`Workspace ${workspaceId} trigger suppression cleared — workspace updated`)
		}
	}

	/**
	 * The single `.catch()` for every `createSession` call in this file.
	 *
	 * Splits session-creation failures into two kinds:
	 *
	 *  - A workspace-level entitlement state (over cap, no credentials). Expected,
	 *    actionable only by the customer, and permanent until they act — so it
	 *    pauses the whole workspace and logs `warn` ONCE per pause. Reporting
	 *    these at `error` on every repeat is what made two customer config
	 *    states into 3,675 Sentry events.
	 *  - Anything else. Still `error`, and now rare enough to be worth alerting on.
	 */
	private handleSessionCreateFailure(
		workspaceId: string,
		err: unknown,
		triggerName?: string,
	): void {
		const now = new Date()

		if (err instanceof PlanCapExceededError) {
			// `periodEnd` is Unix MILLISECONDS. Stripe writes `current_period_end`
			// in seconds, but checkPlanCap converts it before constructing this
			// error (llm-routing.ts `effectivePeriodEnd` takes and returns ms) —
			// so it needs no scaling here. Multiplying by 1000 would push `until`
			// tens of thousands of years out and make the pause permanent.
			const until =
				err.periodEnd !== null && err.periodEnd > now.getTime()
					? new Date(err.periodEnd)
					: new Date(now.getTime() + PLAN_CAP_FALLBACK_SUPPRESSION_MS)
			this.suppressWorkspace(
				workspaceId,
				{
					until,
					reason: `${err.plan} plan cap exceeded ($${(err.used / 100).toFixed(2)} of $${(err.cap / 100).toFixed(2)})`,
				},
				triggerName,
			)
			return
		}

		// `transient` means we could not REACH the provider to check, not that the
		// workspace is misconfigured. Pausing on that would take a workspace's
		// automations offline for an hour over a network blip, so let those fall
		// through to the error branch and retry on the next tick.
		if (err instanceof LlmCredentialsUnavailableError && !err.transient) {
			this.suppressWorkspace(
				workspaceId,
				{
					until: new Date(now.getTime() + NO_CREDENTIALS_SUPPRESSION_MS),
					reason: 'no LLM credentials connected for this workspace',
				},
				triggerName,
			)
			return
		}

		logger.error('Container session creation failed', {
			workspaceId,
			trigger: triggerName,
			error: String(err),
		})
	}

	/**
	 * Entry point for the OTHER session-start path: in production
	 * `SessionManager` hands off to `SessionDispatchQueue` and returns, and the
	 * dispatcher reports failures as return values rather than throws — so a
	 * workspace with no LLM credentials never rejects the `createSession`
	 * promise that `handleSessionCreateFailure` is attached to. Without this the
	 * credential branch there is dead in production, and the trigger keeps firing
	 * on schedule against a workspace that cannot start a session
	 * (Sentry MASKIN-DEV-6). Wired in `index.ts` as the queue's
	 * `onPermanentFailure`.
	 *
	 * Only `not_logged_in` pauses. Every other permanent dispatch failure
	 * (no agent-server took it, a deleted actor) is about the session or the
	 * fleet, not the workspace's entitlement, and the existing per-trigger
	 * backoff — which DOES engage here, because this path emits `session_failed`
	 * — is the right response to those.
	 *
	 * A `not_logged_in` reaching this point is always the non-transient kind:
	 * `SessionDispatcher` returns `permanent_failure` with that classification
	 * only when `!err.transient`, and routes transient credential errors back
	 * through its retry path instead.
	 */
	handleDispatchPermanentFailure(workspaceId: string, reasonCode?: string): void {
		if (reasonCode !== 'not_logged_in') return
		this.suppressWorkspace(workspaceId, {
			until: new Date(Date.now() + NO_CREDENTIALS_SUPPRESSION_MS),
			reason: 'no LLM credentials connected for this workspace',
		})
	}

	/**
	 * Records a pause. Only the transition into a pause logs — a workspace
	 * already suppressed for the same reason stays quiet, so the log carries one
	 * line per workspace per billing period rather than one per trigger per tick.
	 */
	private suppressWorkspace(
		workspaceId: string,
		suppression: WorkspaceSuppression,
		triggerName?: string,
	): void {
		const existing = this.workspaceSuppressions.get(workspaceId)
		this.workspaceSuppressions.set(workspaceId, suppression)
		if (existing && existing.until > new Date() && existing.reason === suppression.reason) return

		logger.warn('Trigger sessions paused for workspace', {
			workspaceId,
			trigger: triggerName,
			reason: suppression.reason,
			until: suppression.until.toISOString(),
		})
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

		// A workspace event whose action is in SUPPRESSION_CLEARING_ACTIONS is the
		// signal that an entitlement may have IMPROVED — a plan upgrade, a credit
		// top-up, a settings PATCH, a recovered subscription. Clearing here is what
		// makes any of them take effect on the next tick rather than at the end of
		// the pause. The action filter is load-bearing in both directions; see the
		// constant for why neither `entity_type === 'workspace'` alone nor
		// `action === 'updated'` alone is correct.
		if (event.entity_type === 'workspace' && SUPPRESSION_CLEARING_ACTIONS.has(event.action)) {
			this.clearWorkspaceSuppression(event.workspace_id)
		}

		if (this.isWorkspaceSuppressed(event.workspace_id)) return

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
			if (!changes || !event.entity_id || !UUID_RE.test(event.entity_id)) return {}
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
				// Object-ness is resolved dynamically: getObjectContext() hydrates
				// from the objects table and returns {} for non-object entities, so
				// custom workspace-defined object types match filters too.
				const isObjectUpdate = event.action === 'updated' || event.action === 'status_changed'
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
				const isObjectUpdate = event.action === 'updated' || event.action === 'status_changed'
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
				.catch((err) => this.handleSessionCreateFailure(event.workspace_id, err, trigger.name))
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
		// Checked before the scope query and the `trigger_fired` event insert:
		// a suppressed workspace should cost nothing per tick, and must not
		// write an audit row claiming a trigger fired when no session follows.
		if (this.isWorkspaceSuppressed(trigger.workspaceId, trigger.name)) return

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
			.catch((err) => this.handleSessionCreateFailure(trigger.workspaceId, err, trigger.name))
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

		// Deliberately NOT gated on isWorkspaceSuppressed: a reminder is one-shot,
		// so skipping it here would consume its timeout and drop it permanently
		// rather than defer it — and being one-shot it cannot produce the
		// repeating volume the suppression exists to stop. It still routes its
		// failure through handleSessionCreateFailure so an over-cap reminder is
		// classified (and can open a pause) rather than paging.
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
				.catch((err) => this.handleSessionCreateFailure(trigger.workspaceId, err, trigger.name))

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

// ─── CommentDispatcher ─────────────────────────────────────────────────────
//
// Subscriber for the `commented` action on `object` entities — the internal
// event shape the shaping spec calls `comment_posted`. Owns the single code
// path for comment→dispatch, running the always-a-responder fallback ladder
// end to end with STOP semantics after the first matching case:
//   • noop_suppressed — `data.metadata.suppress_auto_dispatch === true` short-
//     circuits BEFORE mention / case 2 / case 3, so a bespoke-dispatch caller
//     (e.g. signup-welcome) can stamp the escape hatch on its own comment.
//   • case 1a mention — agent-actor mention → needs_input notification + agent
//     session; human-actor mention → needs_input notification only. Suppressed
//     when the mentioned actor authored the parent comment (`noop_self_authored`).
//   • case 2 driver fallback — no mentions AND joined `objects.driver` on
//     `event.entity_id` is non-null AND ≠ author AND ≠ parent-comment author.
//     Silent dispatch via `sessionManager.createSession(...)` with
//     `triggerSource: 'comment_fallback'` + `sourceCommentEventId`.
//   • case 3 CoS fallback — no eligible driver. Dispatch to the workspace
//     Chief of Staff (spec-fixed actor id) with a wrapped routing prompt
//     (object title + id — not the raw comment) so CoS routes rather than
//     answers. Suppressed when CoS authored the comment or its parent
//     (`noop_self_authored`).
//
// Structured as a class in the same shape as `OrphanThreadDetector` in
// `orphan-thread-detector.ts` — one entry method (`handleEvent`) with focused
// helpers, and its own PgNotifyBridge listener registered on `start()`.
// Wired in `index.ts` alongside `TriggerRunner` / `OrphanThreadDetector`.
//
// Every handled event fires a `comment_responder_resolved` PostHog event
// alongside the structured log line — so Product Validator can attribute the
// drop in `orphan_thread_detected` to specific resolver cases in aggregate.

/** Case tag emitted in the structured per-event log line + PostHog event. */
export type CommentDispatchCase = CommentResponderCase

interface CommentEventData {
	content?: unknown
	mentions?: unknown
	parentEventId?: unknown
	metadata?: { suppress_auto_dispatch?: unknown } | null
}

export class CommentDispatcher {
	private handler: ((event: PgEvent) => void) | null = null

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private sessionManager: SessionManager,
	) {}

	start(): void {
		if (this.handler) return
		this.handler = (event: PgEvent) => {
			if (!this.matches(event)) return
			this.handleEvent(event).catch((err) =>
				logger.error('Comment dispatch failed', {
					eventId: event.event_id,
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		}
		this.bridge.on('event', this.handler)
		logger.info('Comment dispatcher started')
	}

	stop(): void {
		if (this.handler) {
			this.bridge.off('event', this.handler)
			this.handler = null
		}
	}

	private matches(event: PgEvent): boolean {
		return event.entity_type === 'object' && event.action === 'commented'
	}

	async handleEvent(event: PgEvent): Promise<void> {
		const eventIdNum = Number(event.event_id)
		if (!Number.isFinite(eventIdNum)) return

		const [row] = await this.db
			.select({ actorId: events.actorId, data: events.data })
			.from(events)
			.where(eq(events.id, eventIdNum))
			.limit(1)
		if (!row) return

		const data = (row.data ?? {}) as CommentEventData
		const commenterId = row.actorId

		// Bespoke-dispatch escape hatch. A caller that spawns its own session
		// for a comment (e.g. a future signup flow that threads a specific
		// prompt through session-manager directly) can stamp
		// `data.metadata.suppress_auto_dispatch = true` on the comment to
		// prevent the resolver from double-dispatching a generic case-2/case-3
		// session on top. Short-circuits BEFORE the mention / case-2 / case-3
		// branches so nothing downstream can dispatch on a suppressed comment.
		if (
			data.metadata &&
			(data.metadata as { suppress_auto_dispatch?: unknown }).suppress_auto_dispatch === true
		) {
			await this.emitResolved(event, eventIdNum, commenterId, 'noop_suppressed', null)
			return
		}

		const mentions = normalizeMentionsList(data.mentions)
		const parentEventId = normalizeParentEventId(data.parentEventId)
		const parentAuthorId = parentEventId ? await this.parentAuthorId(parentEventId) : null

		if (mentions.length > 0) {
			await this.handleMentions({
				event,
				eventIdNum,
				workspaceId: event.workspace_id,
				commenterId,
				objectId: event.entity_id,
				mentions,
				parentAuthorId,
				content: typeof data.content === 'string' ? data.content : '',
			})
			return
		}

		// No mention → run the case-2 / case-3 fallback ladder. Non-UUID entity
		// ids (slack channel keys, etc.) never resolve to an object row, so
		// skip the join and the whole ladder — nothing here applies to
		// non-object comments (the `matches()` gate already narrows most of
		// them; this covers stray callers that push non-uuid entity ids).
		if (!UUID_RE.test(event.entity_id)) return

		await this.handleFallback({
			event,
			eventIdNum,
			workspaceId: event.workspace_id,
			commenterId,
			entityId: event.entity_id,
			content: typeof data.content === 'string' ? data.content : '',
			parentAuthorId,
		})
	}

	private async handleMentions(ctx: {
		event: PgEvent
		eventIdNum: number
		workspaceId: string
		commenterId: string
		objectId: string
		mentions: string[]
		parentAuthorId: string | null
		content: string
	}): Promise<void> {
		const mentionedActors = await this.db
			.select({ id: actors.id, type: actors.type })
			.from(actors)
			.where(inArray(actors.id, ctx.mentions))

		// Preserve caller ordering (mentions may contain duplicates or ids that
		// don't resolve to an actor row; both cases quietly drop out here).
		const actorById = new Map(mentionedActors.map((a) => [a.id, a]))
		const seen = new Set<string>()
		let anyDispatched = false
		let anyNoopSelfAuthored = false

		for (const mentionId of ctx.mentions) {
			if (seen.has(mentionId)) continue
			seen.add(mentionId)
			const actor = actorById.get(mentionId)
			if (!actor) continue

			if (ctx.parentAuthorId && actor.id === ctx.parentAuthorId) {
				this.log(ctx.event, 'noop_self_authored', actor.id)
				anyNoopSelfAuthored = true
				continue
			}

			await this.dispatchMention({
				event: ctx.event,
				eventId: ctx.eventIdNum,
				workspaceId: ctx.workspaceId,
				commenterId: ctx.commenterId,
				objectId: ctx.objectId,
				actor,
				content: ctx.content,
			})
			anyDispatched = true
		}

		// Emit a single `comment_responder_resolved` per handled event. If ALL
		// resolved mentions were suppressed by the loop-safety guard (parent-
		// author == mentioned actor), tag it `noop_self_authored`. Otherwise
		// tag it `case_1_mention` — a mention that couldn't resolve to an
		// actor row still captures resolver intent, not dispatch success.
		const finalCase: CommentDispatchCase =
			!anyDispatched && anyNoopSelfAuthored ? 'noop_self_authored' : 'case_1_mention'
		await this.emitResolved(ctx.event, ctx.eventIdNum, ctx.commenterId, finalCase, null)
	}

	private async handleFallback(ctx: {
		event: PgEvent
		eventIdNum: number
		workspaceId: string
		commenterId: string
		entityId: string
		content: string
		parentAuthorId: string | null
	}): Promise<void> {
		const [obj] = await this.db
			.select({ driver: objects.driver })
			.from(objects)
			.where(eq(objects.id, ctx.entityId))
			.limit(1)
		const driverId = obj?.driver ?? null

		// Case 2 — driver fallback. Loop-safety option (a): also blocked when
		// the driver authored the PARENT comment we're replying to — otherwise
		// an agent that drives its own bet would ping itself on every reply.
		if (driverId && driverId !== ctx.commenterId && driverId !== ctx.parentAuthorId) {
			await this.dispatchCommentFallback({
				workspaceId: ctx.workspaceId,
				actorId: driverId,
				sourceCommentEventId: ctx.eventIdNum,
				entityId: ctx.entityId,
				actionPrompt: buildCommentFallbackPrompt({
					entityId: ctx.entityId,
					commenterActorId: ctx.commenterId,
					content: ctx.content,
				}),
			})
			await this.emitResolved(
				ctx.event,
				ctx.eventIdNum,
				ctx.commenterId,
				'case_2_driver_fallback',
				driverId,
			)
			return
		}

		// Case 3 — Chief of Staff fallback. The wrapped routing prompt is what
		// stops CoS from silently answering questions the actual owner should
		// route (spec §Product decisions the human owns).
		const cosActorId = CHIEF_OF_STAFF_ACTOR_ID
		if (cosActorId === ctx.commenterId || cosActorId === ctx.parentAuthorId) {
			await this.emitResolved(
				ctx.event,
				ctx.eventIdNum,
				ctx.commenterId,
				'noop_self_authored',
				null,
			)
			return
		}

		await this.dispatchCommentFallback({
			workspaceId: ctx.workspaceId,
			actorId: cosActorId,
			sourceCommentEventId: ctx.eventIdNum,
			entityId: ctx.entityId,
			actionPrompt: await this.buildChiefOfStaffRoutingPrompt({
				entityId: ctx.entityId,
				commenterActorId: ctx.commenterId,
				content: ctx.content,
			}),
		})
		await this.emitResolved(
			ctx.event,
			ctx.eventIdNum,
			ctx.commenterId,
			'case_3_cos_fallback',
			cosActorId,
		)
	}

	private async dispatchCommentFallback(ctx: {
		workspaceId: string
		actorId: string
		sourceCommentEventId: number
		entityId: string
		actionPrompt: string
	}): Promise<void> {
		try {
			await this.sessionManager.createSession(ctx.workspaceId, {
				actorId: ctx.actorId,
				actionPrompt: ctx.actionPrompt,
				createdBy: ctx.actorId,
				triggerSource: 'comment_fallback',
				sourceCommentEventId: ctx.sourceCommentEventId,
				config: {
					comment_fallback: {
						object_id: ctx.entityId,
						source_comment_event_id: ctx.sourceCommentEventId,
					},
				},
			})
		} catch (err) {
			logger.error('Failed to create comment-fallback session', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				sourceCommentEventId: ctx.sourceCommentEventId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	private async buildChiefOfStaffRoutingPrompt(ctx: {
		entityId: string
		commenterActorId: string
		content: string
	}): Promise<string> {
		const [row] = await this.db
			.select({ title: objects.title })
			.from(objects)
			.where(eq(objects.id, ctx.entityId))
			.limit(1)
		const title = row?.title ?? '(untitled object)'
		return [
			`A comment was posted on ${title} (${ctx.entityId}). There is no driver. Decide: assign a driver, forward to a specialist, or answer directly.`,
			'',
			`Commenter actor ID: ${ctx.commenterActorId}`,
			'Original comment:',
			'"""',
			ctx.content,
			'"""',
		].join('\n')
	}

	private async emitResolved(
		event: PgEvent,
		eventIdNum: number,
		commentAuthorId: string,
		kind: CommentDispatchCase,
		resolvedActorId: string | null,
	): Promise<void> {
		// Structured log line — always fires, so the resolver's decisions are
		// traceable in prod logs even if PostHog is unavailable. The `dedupe_hit`
		// field is a v1 placeholder (frozen at false, spec §Idempotency) — kept
		// in the log shape so a future dedupe layer can flip it without
		// changing the format.
		logger.info('Comment responder resolved', {
			event_id: event.event_id,
			case: kind,
			resolved_actor_id: resolvedActorId,
			workspace_id: event.workspace_id,
			object_id: event.entity_id,
			dedupe_hit: false,
		})
		await trackCommentResponderResolved({
			workspaceId: event.workspace_id,
			sourceCommentEventId: eventIdNum,
			commentAuthorId,
			case: kind,
			resolvedActorId,
		})
	}

	private async parentAuthorId(parentEventId: number): Promise<string | null> {
		const [row] = await this.db
			.select({ actorId: events.actorId })
			.from(events)
			.where(eq(events.id, parentEventId))
			.limit(1)
		return row?.actorId ?? null
	}

	private async dispatchMention(ctx: {
		event: PgEvent
		eventId: number
		workspaceId: string
		commenterId: string
		objectId: string
		actor: { id: string; type: string }
		content: string
	}): Promise<void> {
		const [notification] = await this.db.transaction((tx) =>
			insertNotificationsWithEvents(tx, {
				workspaceId: ctx.workspaceId,
				actorId: ctx.commenterId,
				rows: [
					{
						workspaceId: ctx.workspaceId,
						type: 'needs_input' as const,
						title: '@mentioned by comment',
						content: ctx.content,
						sourceActorId: ctx.commenterId,
						targetActorId: ctx.actor.id,
						objectId: ctx.objectId,
						status: 'pending' as const,
					},
				],
			}),
		)

		if (!notification) {
			logger.warn('Comment mention notification not created', {
				eventId: ctx.eventId,
				actorId: ctx.actor.id,
			})
			return
		}

		this.log(ctx.event, 'case_1_mention', ctx.actor.id)

		if (ctx.actor.type !== 'agent') return

		this.sessionManager
			.createSession(ctx.workspaceId, {
				actorId: ctx.actor.id,
				actionPrompt: buildMentionPrompt({
					objectId: ctx.objectId,
					commenterActorId: ctx.commenterId,
					content: ctx.content,
					notificationId: notification.id,
				}),
				config: {
					mention: {
						object_id: ctx.objectId,
						commenter_actor_id: ctx.commenterId,
						notification_id: notification.id,
						comment_event_id: ctx.eventId,
					},
				},
				triggerSource: 'comment_fallback',
				sourceCommentEventId: ctx.eventId,
				createdBy: ctx.commenterId,
			})
			.catch((err) =>
				logger.error('Failed to create session for @mentioned agent', {
					agentId: ctx.actor.id,
					objectId: ctx.objectId,
					notificationId: notification.id,
					error: String(err),
				}),
			)
	}

	private log(event: PgEvent, kind: CommentDispatchCase, resolvedActorId: string): void {
		logger.info('Comment dispatch', {
			event_id: event.event_id,
			case: kind,
			resolved_actor_id: resolvedActorId,
			workspace_id: event.workspace_id,
			object_id: event.entity_id,
		})
	}
}

/**
 * Standard @-mention prompt handed to an agent whose case-1 dispatch fires
 * from `CommentDispatcher`. Kept alongside the dispatcher so the prompt and
 * the notification-id it references are edited in one place.
 */
export function buildMentionPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	notificationId: string
}): string {
	return [
		'You were @mentioned in a comment on an object. Read the comment and the object context, then decide what the right response is. The response can be any combination of:',
		'  - taking an action (updating the object, creating related work, running a tool, kicking off another session, etc.)',
		'  - posting a comment reply (to answer, discuss, acknowledge, or report what you did)',
		'  - doing nothing, if no response is warranted',
		'',
		"Let the context guide you — what is being asked explicitly, what's implied by the thread, and what would actually be useful. Action and comment aren't mutually exclusive: it's often right to do the work and post a short comment about it, or to comment first and then act, or just one or the other. Pick whatever genuinely fits.",
		'',
		`Object ID: ${ctx.objectId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'Comment content:',
		'"""',
		ctx.content,
		'"""',
		'',
		`Once you have done whatever you decided to do (including if that's nothing), mark notification ${ctx.notificationId} as resolved.`,
	].join('\n')
}

/** Coerce the `mentions` field off comment event data into a string[]. */
export function normalizeMentionsList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	return raw.filter((m): m is string => typeof m === 'string' && m.length > 0)
}

/**
 * Parse `data.parentEventId`. Accepts a number or a numeric string (Drizzle
 * JSONB round-trips bigints as strings in some paths); anything else —
 * including NaN/Infinity/0 — becomes null so the caller treats the comment as
 * thread root.
 */
export function normalizeParentEventId(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
	if (typeof raw === 'string' && raw.length > 0) {
		const n = Number(raw)
		if (Number.isFinite(n) && n > 0) return n
	}
	return null
}

/**
 * Prompt handed to the driver on case-2 dispatch. Deliberately terse — the
 * driver knows their own object; the important part is the comment itself.
 */
export function buildCommentFallbackPrompt(ctx: {
	entityId: string
	commenterActorId: string
	content: string
}): string {
	return [
		'A comment was posted on an object you drive that was NOT @mentioning anyone — you are being pinged as the driver of last resort. Read the comment and decide what the right response is: reply in the thread, take an action, or nothing (silence is a valid outcome).',
		'',
		`Object ID: ${ctx.entityId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'Comment content:',
		'"""',
		ctx.content,
		'"""',
	].join('\n')
}
