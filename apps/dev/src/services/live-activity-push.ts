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

/** Min gap between two routine step updates for one session (APNs/iOS budget friendly). */
export const LIVE_ACTIVITY_THROTTLE_MS = 5_000

/**
 * session lifecycle event -> what the Live Activity does.
 *  start   : push-to-start the activity on the human's devices
 *  update  : step changed (throttled)
 *  end     : final state, then the activity is dismissed
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

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private sender: ApnsSender,
		private opts: { throttleMs?: number; now?: () => number } = {},
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
	}

	stop() {
		if (this.handler) this.bridge.off('event', this.handler)
		this.handler = null
		for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer)
		this.pending.clear()
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
			await this.push(sessionId, 'start')
		} else if (UPDATE_ACTIONS.has(event.action)) {
			await this.scheduleUpdate(sessionId)
		} else if (END_STATUS[event.action]) {
			this.clearPending(sessionId)
			await this.push(sessionId, 'end', { endStatus: END_STATUS[event.action] })
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
		await this.push(n.sessionId, 'update', {
			alert: { title: n.title, body: n.content },
			onlyRecipient: n.targetActorId,
		})
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
		const p = this.pending.get(sessionId) ?? { lastSentAt: 0, timer: null }
		this.pending.set(sessionId, p)
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
		} = {},
	): Promise<void> {
		const [row] = await this.db
			.select({
				sessionId: sessions.id,
				workspaceId: sessions.workspaceId,
				conversationId: sessions.conversationId,
				currentActivity: sessions.currentActivity,
				status: sessions.status,
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
		if (targets.length === 0) return

		const push = {
			event: kind,
			sessionId,
			workspaceId: row.workspaceId,
			conversationId: row.conversationId,
			agentName: row.agentName,
			step: row.currentActivity,
			startedAt: row.startedAt ?? row.createdAt ?? new Date(this.now()),
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
