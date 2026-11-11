/**
 * notification-email.ts — an opt-in email for each notification of a kind the person chose.
 *
 * Hooks the same post-commit `events` stream the push uses (PG NOTIFY bridge), on
 * `notification` / `created`, so a rolled-back notification never emails and the write path is
 * untouched. Only Needs you, Chat replies and Tips and updates; Digests have their own switch and
 * Flow activity has its own sender (flow-activity.ts). Every kind is off until the person switches
 * its Email on, so nobody who did not ask gets anything. The daily summary is not touched by these
 * switches, and these switches are not touched by the summary's.
 *
 * How often: the push rules decide (`evaluatePush`, push-policy.ts), run on a ledger of emails of
 * its own. Chat replies are capped per hour and per chat, Tips per day, and three or more For You
 * cards inside ten minutes become one "N things need you" mail. Quiet hours do not apply to email.
 * A muted workspace sends nothing, Needs you included (push still delivers those; email is the
 * louder channel, so muting wins).
 *
 * Exactly once: every replica sees every event, so a mail is claimed with one conditional UPDATE
 * on the notification's own metadata. A failed send releases the claim. FEATURE_BRIEFING_EMAIL=0
 * stops these emails too.
 */
import type { Database } from '@maskin/db'
import { actors, notificationPreferences, notifications } from '@maskin/db/schema'
import { EmailSendError, isEmailConfigured, sendEmail } from '@maskin/email'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, eq, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { buildEmailStopUrl } from '../lib/email-stop-link'
import { isEmailStopConfigured } from '../lib/email-stop-token'
import { logger } from '../lib/logger'
import { EMAIL_KILLSWITCH_ENV_VAR } from './briefing-email-scheduler'
import { buildNotificationEmail } from './notification-email-text'
import { hasReadThrough } from './notification-push'
import {
	DEFAULT_PUSH_PREFS,
	type PushCategory,
	PushLedger,
	collapseKeyOf,
	delaySecondsOf,
	evaluatePush,
	isCriticalCard,
	isForYouCard,
	pushCategoryOf,
} from './push-policy'

/** The kinds this sender mails. Flow activity and the summary have their own senders. */
export const NOTIFICATION_EMAIL_KINDS = ['needs_you', 'conversation', 'tips'] as const
type NotificationEmailKind = (typeof NOTIFICATION_EMAIL_KINDS)[number]

const CLAIM_KEY = 'email_claimed_at'

function isEmailKind(category: PushCategory): category is NotificationEmailKind {
	return (NOTIFICATION_EMAIL_KINDS as readonly string[]).includes(category)
}

type NotificationRow = typeof notifications.$inferSelect

export class NotificationEmailFanout {
	private handler: ((event: PgEvent) => void) | null = null
	private timers = new Map<string, ReturnType<typeof setTimeout>>()
	private ledger = new PushLedger()

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private env: NodeJS.ProcessEnv = process.env,
		private now: () => number = Date.now,
	) {}

	start(): void {
		this.handler = (event) => {
			if (event.entity_type === 'notification' && event.action === 'created') {
				this.handleEvent(event).catch((err) =>
					logger.warn('Notification email failed', { error: String(err) }),
				)
			}
		}
		this.bridge.on('event', this.handler)
	}

	stop(): void {
		if (this.handler) this.bridge.off('event', this.handler)
		this.handler = null
		for (const t of this.timers.values()) clearTimeout(t)
		this.timers.clear()
	}

	async handleEvent(event: PgEvent): Promise<void> {
		// Cheap exit before any DB work when mail cannot go out at all.
		if (!this.sendingAllowed()) return
		const [n] = await this.db
			.select()
			.from(notifications)
			.where(eq(notifications.id, event.entity_id))
			.limit(1)
		if (!n) return
		await this.process(n, null)
	}

	private sendingAllowed(): boolean {
		if (this.env[EMAIL_KILLSWITCH_ENV_VAR] === '0') return false
		if (this.env.NODE_ENV === 'production') {
			return (
				isEmailConfigured(this.env) && Boolean(this.env.APP_URL?.trim()) && isEmailStopConfigured()
			)
		}
		return true
	}

	/** `delayedNowMs` is set on the re-run after a `push_delay_seconds` wait. */
	private async process(n: NotificationRow, delayedNowMs: number | null): Promise<void> {
		// No single recipient, or the person caused it themselves: nothing to tell them.
		if (!n.targetActorId || n.targetActorId === n.sourceActorId) return
		const targetActorId = n.targetActorId
		const meta = (n.metadata ?? {}) as Record<string, unknown>
		const category = pushCategoryOf({ type: n.type, metadata: meta })
		if (!isEmailKind(category)) return

		const [person] = await this.db
			.select({
				email: actors.email,
				emailCategories: notificationPreferences.emailCategories,
				mutedWorkspaceIds: notificationPreferences.mutedWorkspaceIds,
			})
			.from(actors)
			.innerJoin(notificationPreferences, eq(notificationPreferences.actorId, actors.id))
			.where(and(eq(actors.id, targetActorId), eq(actors.type, 'human')))
			.limit(1)
		if (!person?.email || person.emailCategories?.[category] !== true) return
		if (person.mutedWorkspaceIds.includes(n.workspaceId)) return

		const nowMs = delayedNowMs ?? this.now()
		// The push rules, with this kind's Email switch standing in for its Push switch. Tips are
		// "digest-only" for push; a person who switched Tips email on asked for them.
		const verdict = evaluatePush({
			notification: {
				id: n.id,
				type: n.type,
				workspaceId: n.workspaceId,
				targetActorId,
				createdAt: n.createdAt ?? new Date(nowMs),
				metadata: category === 'tips' ? { ...meta, push_force: true } : meta,
				objectId: n.objectId,
			},
			category,
			prefs: {
				...DEFAULT_PUSH_PREFS,
				categories: { ...DEFAULT_PUSH_PREFS.categories, [category]: true },
			},
			now: new Date(nowMs),
			recentPushes: this.ledger.recent(targetActorId, nowMs),
		})

		if (verdict.action === 'skip') return
		if (verdict.action === 'delay') {
			this.scheduleDelayed(n.id, verdict.delayMs ?? delaySecondsOf(meta) * 1000)
			return
		}
		// A rollup after the first one in a window only refreshes a banner for push; for email the
		// first mail already said it.
		if (verdict.action === 'rollup' && verdict.interruption === 'passive') {
			this.record(n, meta, category, verdict.collapseKey ?? null, true, nowMs)
			return
		}

		// Recorded before the send, like push, so every replica's ledger converges.
		this.record(n, meta, category, verdict.collapseKey ?? null, verdict.action === 'rollup', nowMs)
		await this.send(n, category, targetActorId, person.email, meta, verdict.rollupCount)
	}

	private async send(
		n: NotificationRow,
		category: NotificationEmailKind,
		actorId: string,
		email: string,
		meta: Record<string, unknown>,
		rollupCount: number | undefined,
	): Promise<void> {
		if (!(await this.claim(n.id))) return

		const appUrl = this.env.APP_URL?.trim().replace(/\/+$/, '') || 'http://localhost:5173'
		const conversationId = typeof meta.conversation_id === 'string' ? meta.conversation_id : null
		const path = rollupCount
			? `/${n.workspaceId}`
			: conversationId
				? `/${n.workspaceId}/chats/${conversationId}`
				: n.objectId
					? `/${n.workspaceId}/objects/${n.objectId}`
					: `/${n.workspaceId}`
		const mail = buildNotificationEmail({
			title: n.title,
			body: n.content,
			rollupCount,
			buttonUrl: `${appUrl}${path}?surface=email&block=${category}`,
			buttonLabel: rollupCount
				? 'See what needs you'
				: conversationId
					? 'Open the chat'
					: 'Open it',
			stopUrl: buildEmailStopUrl(actorId, this.env, category),
		})
		try {
			const sent = await sendEmail({ to: email, ...mail })
			if (!sent) {
				// No Resend key (a dev copy): nothing left the server, so the claim is not kept.
				await this.release(n.id)
				return
			}
		} catch (err) {
			await this.release(n.id)
			logger.warn('Notification email send failed, claim released', {
				actorId,
				error: err instanceof EmailSendError ? err.providerErrorName : String(err),
			})
			return
		}

		void capturePosthogEvent('email_sent', actorId, {
			workspace_id: n.workspaceId,
			actor_id: actorId,
			actor_type: 'human',
			kind: category,
			...(rollupCount ? { rollup_count: rollupCount } : {}),
		})
	}

	private record(
		n: NotificationRow,
		meta: Record<string, unknown>,
		category: PushCategory,
		collapseKey: string | null,
		rollup: boolean,
		nowMs: number,
	): void {
		if (!n.targetActorId) return
		this.ledger.record({
			notificationId: n.id,
			actorId: n.targetActorId,
			workspaceId: n.workspaceId,
			category,
			collapseKey: collapseKey ?? collapseKeyOf(meta),
			at: nowMs,
			sent: true,
			forYou: isForYouCard({ type: n.type, metadata: meta }),
			critical: isCriticalCard(meta),
			rollup,
		})
	}

	/** Take the notification with one conditional write; false when another replica already has. */
	private async claim(notificationId: string): Promise<boolean> {
		const claimed = await this.db.execute(sql`
			UPDATE notifications
			SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(${CLAIM_KEY}::text, ${new Date(this.now()).toISOString()}::text)
			WHERE id = ${notificationId} AND (metadata->>${CLAIM_KEY}::text) IS NULL
			RETURNING id`)
		return (claimed as unknown as unknown[]).length > 0
	}

	private async release(notificationId: string): Promise<void> {
		await this.db.execute(sql`
			UPDATE notifications SET metadata = metadata - ${CLAIM_KEY}::text WHERE id = ${notificationId}`)
	}

	private scheduleDelayed(notificationId: string, delayMs: number): void {
		if (this.timers.has(notificationId)) return
		const timer = setTimeout(
			() => {
				this.timers.delete(notificationId)
				this.runDelayed(notificationId).catch((err) =>
					logger.warn('Delayed notification email failed', { notificationId, error: String(err) }),
				)
			},
			Math.max(0, Math.ceil(delayMs)),
		)
		timer.unref?.()
		this.timers.set(notificationId, timer)
	}

	/** After the wait: drop it if resolved or already read, else evaluate again. */
	private async runDelayed(notificationId: string): Promise<void> {
		if (!this.sendingAllowed()) return
		const [n] = await this.db
			.select()
			.from(notifications)
			.where(eq(notifications.id, notificationId))
			.limit(1)
		if (!n?.targetActorId) return
		const meta = (n.metadata ?? {}) as Record<string, unknown>
		// Chat replies are stored 'seen' (push-only rows); everything else must still be pending.
		const pushOnly = meta.push_only === true && n.status === 'seen'
		if (n.status !== 'pending' && !pushOnly) return
		if (this.ledger.hasSent(n.targetActorId, n.id)) return
		if (await hasReadThrough(this.db, n.targetActorId, meta)) return

		const earliest = (n.createdAt ?? new Date()).getTime() + delaySecondsOf(meta) * 1000
		await this.process(n, Math.max(this.now(), earliest))
	}
}
