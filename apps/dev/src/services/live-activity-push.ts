import type { Database } from '@maskin/db'
import {
	actors,
	conversations,
	deviceTokens,
	liveActivityCards,
	liveActivityTokens,
	sessionLogs,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { LIVE_ACTIVITY_STALE_S } from './apns'
import type { ApnsSender, LiveActivityEvent } from './apns'
import {
	type WorkingAgent,
	type WorkingSessionRow,
	groupWorkingAgents,
} from './live-activity-agents'
import type { SessionTurnEvent } from './session-manager'

/** Min gap between two routine updates for one workspace (APNs/iOS budget friendly). */
export const LIVE_ACTIVITY_THROTTLE_MS = 5_000

/** Upper bound on every per-workspace / per-session map below, so a leak can never grow without limit. */
export const LIVE_ACTIVITY_MAX_TRACKED = 1_000

/** An interactive session whose last log row is older than this is not mid-turn, whatever it says. */
export const INTERACTIVE_TURN_STALE_MS = 20 * 60 * 1000

/** Card bookkeeping older than this is dropped: the card is long gone. */
export const CARD_TTL_MS = 24 * 60 * 60 * 1000

const LIVE_STATUSES = ['pending', 'starting', 'running']

/**
 * session lifecycle action -> does it change the set of working agents? `session_updated` is the
 * routine step change (throttled); everything else is a lifecycle edge and syncs at once.
 */
const STEP_ACTION = 'session_updated'

/**
 * Lets the token-registration route flush a card whose end (or latest state) had nowhere to go,
 * without owning the sender. Set by `LiveActivityFanout.start()`; a no-op when the fan-out is not
 * running.
 */
let cardFlusher: ((actorId: string, workspaceId: string) => Promise<void>) | null = null
export async function flushLiveActivityCard(actorId: string, workspaceId: string) {
	if (!cardFlusher) return
	try {
		await cardFlusher(actorId, workspaceId)
	} catch (err) {
		logger.warn('Live activity card flush failed', { workspaceId, error: String(err) })
	}
}

interface Pending {
	lastSentAt: number
	timer: ReturnType<typeof setTimeout> | null
}

interface Target {
	id: string
	token: string
	environment: string
}

/**
 * Drives the ONE aggregate "Agents working" Live Activity per recipient and workspace.
 *
 * Like `NotificationPushFanout` it listens to the PG NOTIFY `events` stream (post-commit, off the
 * write path) rather than patching every session mutation site, so a push failure or slowness can
 * never affect a session. For each workspace touched by a session event it recomputes who is
 * working and pushes the difference to every member with a registered ActivityKit token:
 *
 *   0 -> n working : `start` on the member's push-to-start tokens
 *   change         : `update` on the card's update tokens (routine step changes throttled)
 *   n -> 0         : `end` on the update tokens, which then are useless and removed
 *
 * ActivityKit can only end or update a card through that card's OWN push token; a push-to-start
 * token can only start one. When the last agent stops before the device has registered the
 * card's update token, the end is held (`live_activity_cards.end_pending`) and sent the moment
 * the token registers (`flushCard`).
 *
 * "Working" = a non-interactive session that is pending/starting/running, plus an interactive
 * (chat) session with a turn in flight. A chat session stays `running` between turns, so it only
 * counts while a turn is open: SessionManager's `'turn'` events say so, and after a restart the
 * session's last log row decides (a `"type":"result"` row is a closed turn).
 */
export class LiveActivityFanout {
	private handler: ((event: PgEvent) => void) | null = null
	private turnHandler: ((event: SessionTurnEvent) => void) | null = null
	private pending = new Map<string, Pending>()
	/** Interactive sessions with a turn in flight -> when that turn started. */
	private activeTurns = new Map<string, Date>()
	/** `actor|workspace` -> signature of the last state pushed, so an unchanged state sends nothing. */
	private lastSig = new Map<string, string>()
	/** Per-workspace serial queue: two events for one workspace must not both decide "start". */
	private queues = new Map<string, Promise<void>>()

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
		cardFlusher = (actorId, workspaceId) => this.flushCard(actorId, workspaceId)
		this.handler = (event) => {
			if (event.entity_type !== 'session') return
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
		cardFlusher = null
		if (this.handler) this.bridge.off('event', this.handler)
		this.handler = null
		if (this.turnHandler) this.opts.turns?.off('turn', this.turnHandler)
		this.turnHandler = null
		for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer)
		this.pending.clear()
		this.activeTurns.clear()
		this.lastSig.clear()
		this.queues.clear()
	}

	/** Turn boundary of an interactive session: it counts as working only while a turn is open. */
	async handleTurn(event: SessionTurnEvent): Promise<void> {
		if (!this.sender.isEnabled()) return
		if (event.phase === 'started') remember(this.activeTurns, event.sessionId, new Date(this.now()))
		else this.activeTurns.delete(event.sessionId)
		const [row] = await this.db
			.select({ workspaceId: sessions.workspaceId })
			.from(sessions)
			.where(eq(sessions.id, event.sessionId))
			.limit(1)
		if (row) await this.sync(row.workspaceId)
	}

	async handleEvent(event: PgEvent): Promise<void> {
		if (!this.sender.isEnabled()) return
		if (event.entity_type !== 'session') return
		const workspaceId = event.workspace_id
		if (!workspaceId) return
		if (event.action === STEP_ACTION) {
			await this.scheduleStepSync(workspaceId)
			return
		}
		// Lifecycle edge (started, resumed, completed, stopped, failed, paused ...): sync at once.
		if (event.action !== 'session_started' && event.action !== 'session_resumed') {
			this.activeTurns.delete(event.entity_id)
		}
		this.clearPending(workspaceId)
		await this.sync(workspaceId)
	}

	private clearPending(workspaceId: string) {
		const p = this.pending.get(workspaceId)
		if (p?.timer) clearTimeout(p.timer)
		this.pending.delete(workspaceId)
	}

	/** Leading edge syncs at once; further step changes inside the window collapse to one trailing sync. */
	private async scheduleStepSync(workspaceId: string): Promise<void> {
		const throttleMs = this.opts.throttleMs ?? LIVE_ACTIVITY_THROTTLE_MS
		const now = this.now()
		const p = this.pending.get(workspaceId) ?? { lastSentAt: 0, timer: null }
		if (!this.pending.has(workspaceId)) {
			if (this.pending.size >= LIVE_ACTIVITY_MAX_TRACKED) {
				const oldest = this.pending.keys().next().value
				if (oldest !== undefined) this.clearPending(oldest)
			}
			this.pending.set(workspaceId, p)
		}
		const wait = p.lastSentAt + throttleMs - now
		if (wait <= 0) {
			p.lastSentAt = now
			await this.sync(workspaceId)
			return
		}
		if (p.timer) return // a trailing sync is already queued; it reads fresh state when it fires
		p.timer = setTimeout(() => {
			p.timer = null
			p.lastSentAt = this.now()
			this.sync(workspaceId).catch((err) =>
				logger.warn('Live activity update failed', { workspaceId, error: String(err) }),
			)
		}, wait)
		p.timer.unref?.()
	}

	/** The device just registered an update token: deliver whatever the card has been missing. */
	async flushCard(actorId: string, workspaceId: string): Promise<void> {
		if (!this.sender.isEnabled()) return
		await this.sync(workspaceId, { onlyActor: actorId, force: true })
	}

	/** Recompute the working set of a workspace and push the difference. Serialised per workspace. */
	sync(workspaceId: string, opts: { onlyActor?: string; force?: boolean } = {}): Promise<void> {
		const prev = this.queues.get(workspaceId) ?? Promise.resolve()
		const next = prev.then(
			() => this.doSync(workspaceId, opts),
			() => this.doSync(workspaceId, opts),
		)
		const tail = next.catch(() => {})
		this.queues.set(workspaceId, tail)
		tail.then(() => {
			if (this.queues.get(workspaceId) === tail) this.queues.delete(workspaceId)
		})
		return next
	}

	/** Who is working in the workspace right now, one row per agent. */
	async loadWorkingAgents(workspaceId: string): Promise<WorkingAgent[]> {
		const rows = await this.db
			.select({
				sessionId: sessions.id,
				actorId: sessions.actorId,
				agentName: actors.name,
				currentActivity: sessions.currentActivity,
				interactive: sessions.interactive,
				startedAt: sessions.startedAt,
				createdAt: sessions.createdAt,
				conversationId: sessions.conversationId,
				topic: conversations.title,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.leftJoin(conversations, eq(conversations.id, sessions.conversationId))
			.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.status, LIVE_STATUSES)))
		const working: WorkingSessionRow[] = []
		for (const r of rows) {
			let startedAt = r.startedAt ?? r.createdAt ?? new Date(this.now())
			if (r.interactive) {
				const turn = this.activeTurns.get(r.sessionId)
				if (turn) startedAt = turn
				else if (!(await this.turnOpenByLog(r.sessionId))) continue
			}
			working.push({
				sessionId: r.sessionId,
				actorId: r.actorId,
				agentName: r.agentName,
				currentActivity: r.currentActivity,
				startedAt,
				conversationId: r.conversationId,
				topic: r.topic,
			})
		}
		return groupWorkingAgents(working)
	}

	/**
	 * No in-process turn event (restart, or another node ran it): a chat session is mid-turn when
	 * its newest log row is recent and is not the CLI's closing `result` envelope.
	 */
	private async turnOpenByLog(sessionId: string): Promise<boolean> {
		const [last] = await this.db
			.select({ content: sessionLogs.content, createdAt: sessionLogs.createdAt })
			.from(sessionLogs)
			.where(eq(sessionLogs.sessionId, sessionId))
			.orderBy(desc(sessionLogs.id))
			.limit(1)
		if (!last) return false
		if (last.createdAt && this.now() - last.createdAt.getTime() > INTERACTIVE_TURN_STALE_MS) {
			return false
		}
		return !last.content.includes('"type":"result"')
	}

	private async doSync(
		workspaceId: string,
		opts: { onlyActor?: string; force?: boolean },
	): Promise<void> {
		const agents = await this.loadWorkingAgents(workspaceId)

		const startTokens = await this.db
			.select({
				id: liveActivityTokens.id,
				actorId: liveActivityTokens.actorId,
				token: liveActivityTokens.token,
				environment: deviceTokens.environment,
			})
			.from(liveActivityTokens)
			.innerJoin(deviceTokens, eq(deviceTokens.id, liveActivityTokens.deviceId))
			.innerJoin(
				workspaceMembers,
				and(
					eq(workspaceMembers.actorId, liveActivityTokens.actorId),
					eq(workspaceMembers.workspaceId, workspaceId),
				),
			)
			.where(
				and(
					eq(liveActivityTokens.kind, 'push_to_start'),
					// The device may have changed hands since the token was registered.
					eq(deviceTokens.actorId, liveActivityTokens.actorId),
				),
			)
		const updateTokens = await this.db
			.select({
				id: liveActivityTokens.id,
				actorId: liveActivityTokens.actorId,
				token: liveActivityTokens.token,
				environment: deviceTokens.environment,
			})
			.from(liveActivityTokens)
			.innerJoin(deviceTokens, eq(deviceTokens.id, liveActivityTokens.deviceId))
			.where(
				and(
					eq(liveActivityTokens.kind, 'update'),
					eq(liveActivityTokens.workspaceId, workspaceId),
					// The device may have changed hands since the token was registered.
					eq(deviceTokens.actorId, liveActivityTokens.actorId),
				),
			)
		const cards = await this.db
			.select()
			.from(liveActivityCards)
			.where(eq(liveActivityCards.workspaceId, workspaceId))

		const actorIds = new Set<string>()
		for (const t of startTokens) actorIds.add(t.actorId)
		for (const t of updateTokens) actorIds.add(t.actorId)
		for (const c of cards) actorIds.add(c.actorId)

		const sig = JSON.stringify(
			agents.map((a) => [a.id, a.sessionId, a.doing ?? '', a.topic ?? '', a.startedAt.getTime()]),
		)
		const now = this.now()

		for (const actorId of actorIds) {
			if (opts.onlyActor && opts.onlyActor !== actorId) continue
			const key = `${actorId}|${workspaceId}`
			const mine = <T extends { actorId: string }>(rows: T[]) =>
				rows.filter((r) => r.actorId === actorId)
			const starts = mine(startTokens)
			const updates = mine(updateTokens)
			const card = cards.find((c) => c.actorId === actorId)

			if (card && now - card.updatedAt.getTime() > CARD_TTL_MS && updates.length === 0) {
				await this.db
					.delete(liveActivityCards)
					.where(
						and(
							eq(liveActivityCards.actorId, actorId),
							eq(liveActivityCards.workspaceId, workspaceId),
						),
					)
				this.lastSig.delete(key)
				continue
			}

			if (agents.length > 0) {
				// A card whose end was held, or that never got an update token and has outlived its
				// stale date, is gone from the device (swiped away / stale): a new start is allowed.
				const leftover =
					!!card &&
					updates.length === 0 &&
					(card.endPending || now - card.updatedAt.getTime() > LIVE_ACTIVITY_STALE_S * 1000)
				const exists = (!!card && !leftover) || updates.length > 0
				if (exists) {
					if (updates.length === 0) continue // card up, token not registered yet: heals on register
					if (!opts.force && this.lastSig.get(key) === sig) continue
					await this.deliver(updates, { event: 'update', workspaceId, agents })
					this.lastSig.set(key, sig)
					await this.touchCard(actorId, workspaceId, false)
				} else if (starts.length > 0) {
					await this.deliver(starts, { event: 'start', workspaceId, agents })
					this.lastSig.set(key, sig)
					await this.touchCard(actorId, workspaceId, false)
				}
				continue
			}

			// Nobody is working any more.
			if (updates.length > 0) {
				await this.deliver(updates, { event: 'end', workspaceId, agents: [] })
				await this.db.delete(liveActivityTokens).where(
					inArray(
						liveActivityTokens.id,
						updates.map((u) => u.id),
					),
				)
				await this.db
					.delete(liveActivityCards)
					.where(
						and(
							eq(liveActivityCards.actorId, actorId),
							eq(liveActivityCards.workspaceId, workspaceId),
						),
					)
				this.lastSig.delete(key)
			} else if (card && !card.endPending) {
				// The card is up but the device never registered its update token: hold the end.
				await this.touchCard(actorId, workspaceId, true)
				this.lastSig.delete(key)
			}
		}
	}

	private async touchCard(actorId: string, workspaceId: string, endPending: boolean) {
		const now = new Date(this.now())
		await this.db
			.insert(liveActivityCards)
			.values({ actorId, workspaceId, endPending, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: [liveActivityCards.actorId, liveActivityCards.workspaceId],
				set: { endPending, updatedAt: now },
			})
	}

	private async deliver(
		targets: Target[],
		push: { event: LiveActivityEvent; workspaceId: string; agents: WorkingAgent[] },
	): Promise<void> {
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
