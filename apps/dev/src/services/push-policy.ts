/**
 * Push policy: decides whether (and how loudly) a notification becomes a push.
 *
 * `evaluatePush` is PURE: no clock, DB or I/O. Everything it needs comes in through its
 * arguments, which makes every rule deterministic and unit-testable. `NotificationPushFanout`
 * gathers the inputs (preferences row, recent pushes) and acts on the verdict.
 *
 * Producers steer it through `notifications.metadata`:
 *   push_category       'needs_you' | 'conversation' | 'digest' | 'tips'. Absent => inferred:
 *                       type needs_input => needs_you, anything else => digest.
 *   push_collapse_key   string; a newer push with the same key replaces an older one.
 *   push_delay_seconds  hold the push this long; the fan-out re-checks read state afterwards.
 *   push_force          true lets a digest/tips notification push individually.
 *   priority 'critical' / blocking true   a For You card that bypasses the rollup.
 *   source              'comment_mention' on the row an @mention of a person creates.
 *   due_at              ISO time a needs_you item expires; the push text leads with it.
 *
 * The last two only matter for a person with the PUSH_HUMAN_DECISIONS_ONLY flag (`gate`).
 *
 * ── The "recent pushes" ledger ──────────────────────────────────────────────
 * Rate limits and the For You rollup need to know what was recently pushed. The ledger is an
 * in-process `PushLedger` (bounded, pruned to 24 h) plus, for For You cards, rows read from
 * the `notifications` table, which makes the rollup count restart-safe and replica-safe.
 * Why in-memory is good enough for the rate limits: every replica receives EVERY notification
 * event over PG NOTIFY and runs the same fan-out, so each replica's ledger converges on the
 * same history; replicas that both decide to send produce the same `apns-collapse-id`
 * / Web Push topic, so the device shows one notification. Worst case after a restart, the
 * ledger is empty and a rate limit resets, which errs towards delivering, never towards
 * dropping a needs_you.
 */
import { FOR_YOU_KIND, type PushCategory } from '@maskin/shared'
import type { PushInterruption } from './push-types'

export type { PushCategory }

export interface PushPrefs {
	/** IANA name; null => UTC. */
	timezone: string | null
	/** Minutes from local midnight; both null => no quiet hours. start > end wraps midnight. */
	quietHoursStart: number | null
	quietHoursEnd: number | null
	categories: Record<PushCategory, boolean>
	mutedWorkspaceIds: string[]
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
	timezone: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	categories: { needs_you: true, conversation: true, digest: true, tips: true },
	mutedWorkspaceIds: [],
}

export interface PolicyNotification {
	id: string
	type: string
	workspaceId: string
	targetActorId: string
	createdAt: Date
	metadata: Record<string, unknown>
	objectId?: string | null
}

/** One thing the ledger remembers about an earlier notification for an actor. */
export interface RecentPush {
	notificationId: string
	actorId: string
	workspaceId: string
	category: PushCategory
	collapseKey: string | null
	/** Epoch ms: when the push went out, or for a For You card when it was created. */
	at: number
	/** A push actually left the server for it (a rolled-up card counts as not sent). */
	sent: boolean
	/** A For You needs_you card (counted towards the rollup). */
	forYou: boolean
	/** That card was critical (never counted, never rolled up). */
	critical: boolean
	/** This entry is the rollup push itself. */
	rollup: boolean
}

export type PushAction = 'send' | 'skip' | 'delay' | 'rollup'

export interface PushVerdict {
	action: PushAction
	interruption: PushInterruption
	reason: string
	/** For 'delay': ms still to wait before re-evaluating. */
	delayMs?: number
	/** For 'rollup': how many cards the single push stands for. */
	rollupCount?: number
	/** The key to collapse on (always set for a rollup). */
	collapseKey?: string
}

export const LIMITS = {
	conversationPerHour: 6,
	conversationPerKeyMs: 2 * 60_000,
	tipsPerDay: 2,
	rollupMinCards: 3,
	rollupWindowMs: 10 * 60_000,
	maxDelaySeconds: 3600,
} as const
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const CATEGORIES: readonly PushCategory[] = ['needs_you', 'conversation', 'digest', 'tips']

export function pushCategoryOf(n: Pick<PolicyNotification, 'type' | 'metadata'>): PushCategory {
	const c = n.metadata.push_category
	if (typeof c === 'string' && (CATEGORIES as readonly string[]).includes(c)) {
		return c as PushCategory
	}
	return n.type === 'needs_input' ? 'needs_you' : 'digest'
}

export function isForYouCard(n: Pick<PolicyNotification, 'type' | 'metadata'>): boolean {
	return n.type === 'needs_input' && n.metadata.kind === FOR_YOU_KIND
}

export function isCriticalCard(metadata: Record<string, unknown>): boolean {
	return metadata.priority === 'critical' || metadata.blocking === true
}

export function collapseKeyOf(metadata: Record<string, unknown>): string | null {
	const k = metadata.push_collapse_key
	return typeof k === 'string' && k.trim().length > 0 ? k.trim() : null
}

/** The deadline a producer put on a notification; null when absent or not a valid time. */
export function dueAtOf(metadata: Record<string, unknown>): Date | null {
	const d = metadata.due_at
	if (typeof d !== 'string' || d.length > 40) return null
	const at = new Date(d)
	return Number.isNaN(at.getTime()) ? null : at
}

/** "Mon 26 Oct 08:00 UTC", in the person's timezone (UTC when none or invalid). */
export function formatDeadline(at: Date, timezone: string | null): string {
	const fmt = (tz: string) =>
		new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			timeZoneName: 'short',
		})
			.format(at)
			.replace(',', '')
	try {
		return fmt(timezone ?? 'UTC')
	} catch {
		return fmt('UTC')
	}
}

/** Puts the deadline at the front of a push body: "Before Mon 26 Oct 08:00 UTC · <body>". */
export function withDeadline(
	body: string | null,
	due: Date,
	now: Date,
	timezone: string | null,
): string {
	const lead = `${due.getTime() < now.getTime() ? 'Overdue since' : 'Before'} ${formatDeadline(due, timezone)}`
	return body ? `${lead} · ${body}` : lead
}

export function delaySecondsOf(metadata: Record<string, unknown>): number {
	const d = metadata.push_delay_seconds
	if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return 0
	return Math.min(d, LIMITS.maxDelaySeconds)
}

/** Minutes since local midnight at `at` in `timezone`; an unknown/null timezone means UTC. */
export function localMinuteOfDay(at: Date, timezone: string | null): number {
	if (timezone) {
		try {
			const parts = new Intl.DateTimeFormat('en-US', {
				timeZone: timezone,
				hourCycle: 'h23',
				hour: '2-digit',
				minute: '2-digit',
			}).formatToParts(at)
			const hour = Number(parts.find((p) => p.type === 'hour')?.value)
			const minute = Number(parts.find((p) => p.type === 'minute')?.value)
			if (Number.isFinite(hour) && Number.isFinite(minute)) return (hour % 24) * 60 + minute
		} catch {
			// invalid stored timezone: fall through to UTC
		}
	}
	return at.getUTCHours() * 60 + at.getUTCMinutes()
}

export function inQuietHours(prefs: PushPrefs, at: Date): boolean {
	const { quietHoursStart: start, quietHoursEnd: end } = prefs
	if (start == null || end == null || start === end) return false
	const m = localMinuteOfDay(at, prefs.timezone)
	return start < end ? m >= start && m < end : m >= start || m < end
}

export interface EvaluatePushInput {
	notification: PolicyNotification
	category: PushCategory
	prefs: PushPrefs
	now: Date
	recentPushes: RecentPush[]
	/** PUSH_HUMAN_DECISIONS_ONLY is on for this person. */
	gate?: boolean
	/** The notification is an @mention comment that carries a decision block. */
	hasDecision?: boolean
}

export function evaluatePush({
	notification: n,
	category,
	prefs,
	now,
	recentPushes,
	gate = false,
	hasDecision = false,
}: EvaluatePushInput): PushVerdict {
	const nowMs = now.getTime()
	const meta = n.metadata
	const mine = recentPushes.filter(
		(r) => r.actorId === n.targetActorId && r.notificationId !== n.id,
	)
	const collapseKey = collapseKeyOf(meta) ?? undefined
	const skip = (reason: string): PushVerdict => ({ action: 'skip', interruption: 'active', reason })

	if (prefs.categories[category] === false) return skip('category-disabled')

	// A plain @mention is context, not a decision: it stays in the app. A mention that carries
	// a decision block, and every card or chat question, still pushes.
	if (
		gate &&
		category === 'needs_you' &&
		meta.push_category === undefined &&
		meta.source === 'comment_mention' &&
		!hasDecision
	) {
		return skip('mention-without-decision')
	}

	const muted = prefs.mutedWorkspaceIds.includes(n.workspaceId)
	if (muted && category !== 'needs_you') return skip('workspace-muted')

	if ((category === 'digest' || category === 'tips') && meta.push_force !== true) {
		return skip('digest-only')
	}

	const delayMs = delaySecondsOf(meta) * 1000 - (nowMs - n.createdAt.getTime())
	if (delayMs > 0) {
		return { action: 'delay', interruption: 'active', reason: 'delayed', delayMs, collapseKey }
	}

	// Needs-you pushes are time-sensitive, except in a muted workspace where they stay
	// delivered but without breaking through Focus. Other categories are plain 'active'.
	let interruption: PushInterruption =
		category === 'needs_you' ? (muted ? 'active' : 'time-sensitive') : 'active'

	if (category !== 'needs_you') {
		const sent = mine.filter((r) => r.sent)
		if (category === 'conversation') {
			const lastHour = sent.filter((r) => r.category === 'conversation' && nowMs - r.at < HOUR_MS)
			if (lastHour.length >= LIMITS.conversationPerHour) return skip('rate-limit-hour')
			if (
				collapseKey &&
				lastHour.some(
					(r) => r.collapseKey === collapseKey && nowMs - r.at < LIMITS.conversationPerKeyMs,
				)
			) {
				return skip('rate-limit-collapse-key')
			}
		} else if (category === 'tips') {
			if (
				sent.filter((r) => r.category === 'tips' && nowMs - r.at < DAY_MS).length >=
				LIMITS.tipsPerDay
			) {
				return skip('rate-limit-day')
			}
		}
	}

	if (inQuietHours(prefs, now)) interruption = 'passive'

	if (category === 'needs_you' && isForYouCard(n) && !isCriticalCard(meta)) {
		const cards = new Set(
			mine
				.filter(
					(r) =>
						r.forYou &&
						!r.critical &&
						r.workspaceId === n.workspaceId &&
						nowMs - r.at <= LIMITS.rollupWindowMs,
				)
				.map((r) => r.notificationId),
		)
		cards.add(n.id)
		if (cards.size >= LIMITS.rollupMinCards) {
			const key = `foryou:${n.workspaceId}`
			// The first rollup in a window buzzes; later ones only refresh the same banner quietly.
			const alreadyRolledUp = mine.some(
				(r) =>
					r.rollup &&
					r.sent &&
					r.workspaceId === n.workspaceId &&
					nowMs - r.at <= LIMITS.rollupWindowMs,
			)
			return {
				action: 'rollup',
				interruption: alreadyRolledUp ? 'passive' : interruption,
				reason: 'foryou-rollup',
				rollupCount: cards.size,
				collapseKey: key,
			}
		}
	}

	// A second ask about the same object replaces the first banner instead of stacking.
	const objectKey =
		gate && category === 'needs_you' && !collapseKey && n.objectId ? `object:${n.objectId}` : null

	return {
		action: 'send',
		interruption,
		reason: inQuietHours(prefs, now) ? 'quiet-hours' : muted ? 'muted-needs-you' : 'ok',
		collapseKey: collapseKey ?? objectKey ?? undefined,
	}
}

/** Bounded in-process record of what each actor was recently notified about. */
export class PushLedger {
	private byActor = new Map<string, RecentPush[]>()
	constructor(
		private maxPerActor = 200,
		private retentionMs = DAY_MS,
	) {}

	record(entry: RecentPush): void {
		const list = (this.byActor.get(entry.actorId) ?? []).filter(
			(r) => entry.at - r.at < this.retentionMs && r.notificationId !== entry.notificationId,
		)
		list.push(entry)
		this.byActor.set(entry.actorId, list.slice(-this.maxPerActor))
	}

	recent(actorId: string, nowMs: number): RecentPush[] {
		return (this.byActor.get(actorId) ?? []).filter((r) => nowMs - r.at < this.retentionMs)
	}

	hasSent(actorId: string, notificationId: string): boolean {
		return (this.byActor.get(actorId) ?? []).some(
			(r) => r.notificationId === notificationId && r.sent,
		)
	}
}
