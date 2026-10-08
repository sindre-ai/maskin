import type { Database } from '@maskin/db'
import {
	actors,
	conversations,
	deviceTokens,
	liveActivityTokens,
	notifications,
	sessions,
} from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, eq, inArray } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { ApnsSender, LiveActivityEvent, LiveActivityStatus } from './apns'
import type { SessionTurnEvent } from './session-manager'

/** Min gap between two routine step updates for one session (APNs/iOS budget friendly). */
export const LIVE_ACTIVITY_THROTTLE_MS = 5_000

/** Upper bound on every per-session map below, so a leaked entry can never grow without limit. */
export const LIVE_ACTIVITY_MAX_TRACKED = 1_000
/** How long an update that found no tokens suppresses further lookups for that session. */
const NO_TOKENS_TTL_MS = 5_000

/**
 * session lifecycle event -> what the Live Activity does.
 *  start   : push-to-start the activity on the human's devices
 *  update  : step changed (throttled)
 *  end     : final state, then the activity is dismissed
 *
 * Interactive (chat) sessions stay `running` across many turns, so their
 * activity follows the TURN, not the session: it starts when a user turn is
 * written to the CLI and ends when the turn's closing message is posted (both
 * signalled in-process by SessionManager's `'turn'` event). Session-level
 * start events are ignored for them; session-level end events remain as a
 * safety net, because an end for an activity that is already gone is a no-op.
 */
const START_ACTIONS = new Set(['session_started', 'session_resumed'])
const UPDATE_ACTIONS = new Set(['session_updated'])
const END_STATUS: Record<string, LiveActivityStatus> = {
	session_completed: 'done',
	session_stopped: 'done',
	session_paused: 'done',
	session_failed: 'failed',
	session_timeout: 'failed',
	session_budget_stopped: 'failed',
}

interface Pending {
	lastSentAt: number
	timer: ReturnType<typeof setTimeout> | null
}

/**
 * Drives iOS Live Activities for a running agent turn.
 *
 * Like `NotificationPushFanout` it listens to the PG NOTIFY `events` stream (post-commit,
 * entirely off the write path) instead of patching every session mutation site, so a push
 * failure or slowness can never affect a session. Only sessions bound to a conversation are
 * mirrored, to the conversation's creator — a person watching a chat, not every background
 * loop run. With APNs unconfigured, or no registered ActivityKit tokens, it does nothing.
 */
export class LiveActivityFanout {
	private handler: ((event: PgEvent) => void) | null = null
	private pending = new Map<string, Pending>()
	/** Interactive sessions with a turn in flight -> when that turn started (their activity is live). */
	private activeTurns = new Map<string, Date>()
	/** sessionId -> until when an update lookup may be skipped (no registered tokens). */
	private noTokensUntil = new Map<string, number>()
	private turnHandler: ((event: SessionTurnEvent) => void) | null = null

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private sender: ApnsSender,
		private opts: {
			throttleMs?: number
			now?: () => number
			/** Emits `'turn'` (SessionTurnEvent) — in practice the SessionManager. */
			turns?: Pick<NodeJS.EventEmitter, 'on' | 'off'>
		} = {},
	) {}

	private now() {
		return (this.opts.now ?? Date.now)()
	}

	start() {
		this.handler = (event) => {
			const relevant =
				event.entity_type === 'session' ||
				(event.entity_type === 'notification' && event.action === 'created')
			if (!relevant) return
			this.handleEvent(event).catch((err) =>
				logger.warn('Live activity fan-out failed', { error: String(err) }),
			)
		}
		this.bridge.on('event', this.handler)
		if (this.opts.turns) {
			this.turnHandler = (event) => {
				this.handleTurn(event).catch((err) =>
					logger.warn('Live activity turn fan-out failed', { error: String(err) }),
				)
			}
			this.opts.turns.on('turn', this.turnHandler)
		}
	}

	stop() {
		if (this.handler) this.bridge.off('event', this.handler)
		this.handler = null
		if (this.turnHandler) this.opts.turns?.off('turn', this.turnHandler)
		this.turnHandler = null
		for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer)
		this.pending.clear()
		this.activeTurns.clear()
		this.noTokensUntil.clear()
	}

	/** Turn boundary of an interactive session: the activity starts and ends with it. */
	async handleTurn(event: SessionTurnEvent): Promise<void> {
		if (!this.sender.isEnabled()) return
		const { sessionId } = event
		if (event.phase === 'started') {
			const startedAt = new Date(this.now())
			remember(this.activeTurns, sessionId, startedAt)
			this.clearPending(sessionId)
			this.noTokensUntil.delete(sessionId)
			await this.push(sessionId, 'start', { turn: true })
		} else {
			const startedAt = this.activeTurns.get(sessionId)
			this.activeTurns.delete(sessionId)
			this.clearPending(sessionId)
			await this.push(sessionId, 'end', {
				endStatus: event.outcome === 'failed' ? 'failed' : 'done',
				startedAt,
			})
		}
	}

	async handleEvent(event: PgEvent): Promise<void> {
		if (!this.sender.isEnabled()) return

		if (event.entity_type === 'notification') {
			await this.handleNotification(event)
			return
		}
		if (event.entity_type !== 'session') return

		const sessionId = event.entity_id
		if (START_ACTIONS.has(event.action)) {
			this.clearPending(sessionId)
			this.noTokensUntil.delete(sessionId)
			await this.push(sessionId, 'start')
		} else if (UPDATE_ACTIONS.has(event.action)) {
			await this.scheduleUpdate(sessionId)
		} else if (END_STATUS[event.action]) {
			const startedAt = this.activeTurns.get(sessionId)
			this.activeTurns.delete(sessionId)
			this.clearPending(sessionId)
			this.noTokensUntil.delete(sessionId)
			await this.push(sessionId, 'end', { endStatus: END_STATUS[event.action], startedAt })
		}
	}

	/** A needs_input notification tied to a session flips its activity to "needs you" now. */
	private async handleNotification(event: PgEvent) {
		const [n] = await this.db
			.select({
				type: notifications.type,
				sessionId: notifications.sessionId,
				targetActorId: notifications.targetActorId,
				title: notifications.title,
				content: notifications.content,
			})
			.from(notifications)
			.where(eq(notifications.id, event.entity_id))
			.limit(1)
		if (!n || n.type !== 'needs_input' || !n.sessionId) return
		this.clearPending(n.sessionId)
		this.noTokensUntil.delete(n.sessionId)
		await this.push(n.sessionId, 'update', {
			alert: { title: n.title, body: n.content },
			onlyRecipient: n.targetActorId,
		})
	}

	private rememberNoTokens(sessionId: string) {
		if (
			!this.noTokensUntil.has(sessionId) &&
			this.noTokensUntil.size >= LIVE_ACTIVITY_MAX_TRACKED
		) {
			const oldest = this.noTokensUntil.keys().next().value
			if (oldest !== undefined) this.noTokensUntil.delete(oldest)
		}
		this.noTokensUntil.set(sessionId, this.now() + NO_TOKENS_TTL_MS)
	}

	private clearPending(sessionId: string) {
		const p = this.pending.get(sessionId)
		if (p?.timer) clearTimeout(p.timer)
		this.pending.delete(sessionId)
	}

	/** Leading edge sends at once; further updates inside the window collapse to one trailing send. */
	private async scheduleUpdate(sessionId: string): Promise<void> {
		const throttleMs = this.opts.throttleMs ?? LIVE_ACTIVITY_THROTTLE_MS
		const now = this.now()
		// Nobody is showing this session's activity: skip the lookups entirely.
		if ((this.noTokensUntil.get(sessionId) ?? 0) > now) return
		const p = this.pending.get(sessionId) ?? { lastSentAt: 0, timer: null }
		if (!this.pending.has(sessionId)) {
			// Bounded: evict the oldest entry (and its timer) rather than grow forever.
			if (this.pending.size >= LIVE_ACTIVITY_MAX_TRACKED) {
				const oldest = this.pending.keys().next().value
				if (oldest !== undefined) this.clearPending(oldest)
			}
			this.pending.set(sessionId, p)
		}
		const wait = p.lastSentAt + throttleMs - now
		if (wait <= 0) {
			p.lastSentAt = now
			await this.push(sessionId, 'update')
			return
		}
		if (p.timer) return // a trailing send is already queued; it reads fresh state when it fires
		p.timer = setTimeout(() => {
			p.timer = null
			p.lastSentAt = this.now()
			this.push(sessionId, 'update').catch((err) =>
				logger.warn('Live activity update failed', { sessionId, error: String(err) }),
			)
		}, wait)
		p.timer.unref?.()
	}

	private async push(
		sessionId: string,
		kind: LiveActivityEvent,
		extra: {
			endStatus?: LiveActivityStatus
			alert?: { title: string; body?: string | null }
			onlyRecipient?: string | null
			/** Start caused by an interactive turn boundary rather than a session lifecycle event. */
			turn?: boolean
			/** Overrides the session's start as the activity's elapsed-time origin (turn start). */
			startedAt?: Date
		} = {},
	): Promise<void> {
		const [row] = await this.db
			.select({
				sessionId: sessions.id,
				workspaceId: sessions.workspaceId,
				conversationId: sessions.conversationId,
				currentActivity: sessions.currentActivity,
				status: sessions.status,
				interactive: sessions.interactive,
				startedAt: sessions.startedAt,
				createdAt: sessions.createdAt,
				agentName: actors.name,
				recipientId: conversations.createdBy,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.innerJoin(conversations, eq(conversations.id, sessions.conversationId))
			.where(eq(sessions.id, sessionId))
			.limit(1)
		// No conversation = a background run nobody is watching in a chat.
		if (!row) return
		// A "needs you" nudge for someone other than the chat's owner is not ours to show.
		if (extra.onlyRecipient && extra.onlyRecipient !== row.recipientId) return
		// A chat session is `running` between turns; only its turns have an activity.
		if (row.interactive) {
			if (kind === 'start' && !extra.turn) return
			if (kind === 'update' && !this.activeTurns.has(sessionId)) return
		}

		const tokens = await this.db
			.select({
				id: liveActivityTokens.id,
				kind: liveActivityTokens.kind,
				token: liveActivityTokens.token,
				deviceId: liveActivityTokens.deviceId,
				sessionId: liveActivityTokens.sessionId,
				environment: deviceTokens.environment,
			})
			.from(liveActivityTokens)
			.innerJoin(deviceTokens, eq(deviceTokens.id, liveActivityTokens.deviceId))
			.where(
				and(
					eq(liveActivityTokens.actorId, row.recipientId),
					kind === 'start'
						? inArray(liveActivityTokens.kind, ['push_to_start', 'update'])
						: eq(liveActivityTokens.sessionId, sessionId),
				),
			)

		// Start only the devices that are not already showing this session's activity.
		let targets = tokens
		if (kind === 'start') {
			const running = new Set(
				tokens
					.filter((t) => t.kind === 'update' && t.sessionId === sessionId)
					.map((t) => t.deviceId),
			)
			targets = tokens.filter((t) => t.kind === 'push_to_start' && !running.has(t.deviceId))
		} else {
			targets = tokens.filter((t) => t.kind === 'update')
		}
		if (targets.length === 0) {
			// Remember it so the next burst of updates does not repeat 3 queries to find nothing.
			if (kind === 'update') this.rememberNoTokens(sessionId)
			return
		}

		let status: LiveActivityStatus = extra.endStatus ?? 'running'
		if (kind !== 'end') {
			const [waiting] = await this.db
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.sessionId, sessionId),
						eq(notifications.targetActorId, row.recipientId),
						eq(notifications.type, 'needs_input'),
						eq(notifications.status, 'pending'),
					),
				)
				.limit(1)
			if (waiting) status = 'needsYou'
		}

		const push = {
			event: kind,
			sessionId,
			workspaceId: row.workspaceId,
			conversationId: row.conversationId,
			agentName: row.agentName,
			step: row.currentActivity,
			startedAt:
				extra.startedAt ??
				this.activeTurns.get(sessionId) ??
				row.startedAt ??
				row.createdAt ??
				new Date(this.now()),
			status,
			alert: extra.alert ?? null,
		}

		const dead: string[] = []
		await Promise.all(
			targets.map(async (t) => {
				const result = await this.sender.sendLiveActivity(
					{ token: t.token, environment: t.environment },
					push,
				)
				if (result === 'dead') dead.push(t.id)
			}),
		)
		if (dead.length > 0) {
			await this.db.delete(liveActivityTokens).where(inArray(liveActivityTokens.id, dead))
		}
		if (kind === 'end') {
			// The activity is over; its update tokens are now useless.
			await this.db
				.delete(liveActivityTokens)
				.where(
					and(eq(liveActivityTokens.sessionId, sessionId), eq(liveActivityTokens.kind, 'update')),
				)
		}
	}
}

/** Insert into a Map capped at LIVE_ACTIVITY_MAX_TRACKED, evicting the oldest key. */
function remember(map: Map<string, Date>, key: string, value: Date) {
	if (!map.has(key) && map.size >= LIVE_ACTIVITY_MAX_TRACKED) {
		const oldest = map.keys().next().value
		if (oldest !== undefined) map.delete(oldest)
	}
	map.set(key, value)
}
