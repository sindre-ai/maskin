/**
 * Web Push sender — the browser counterpart of `apns.ts` (Chrome, Edge, Firefox, Safari 16+,
 * on macOS, Windows, Linux and Android). Implements `PushChannel`, so `NotificationPushFanout`
 * drives it exactly like APNs.
 *
 * Config (all read from env; if any is missing the sender is DISABLED — it logs once and every
 * send is a silent no-op, never a throw):
 *   VAPID_PUBLIC_KEY   URL-safe base64 P-256 public key (also served to the browser, by design)
 *   VAPID_PRIVATE_KEY  matching private key — a real secret
 *   VAPID_SUBJECT      `mailto:` or `https:` contact the push services may use to reach us
 * Generate a pair with `npx web-push generate-vapid-keys`.
 *
 * The payload is the deliberately small shape `apps/web/public/sw.js` reads: title, body, a
 * same-origin `url` to open, and a `tag`. Browsers show at most two action buttons (Safari none)
 * and can't post a reply, so decision buttons stay native-only: a click on a decision opens the
 * object it belongs to, where the decision card is.
 *
 * A 404 or 410 from the push service means the subscription is gone (the user revoked
 * permission or the browser dropped it); the row is deleted so it stops being targeted.
 */
import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { webPushSubscriptions } from '@maskin/db/schema'
import { isAllowedWebPushEndpoint } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { logger } from '../lib/logger'
import type { PushChannel, PushMessage } from './push-types'

export interface WebPushConfig {
	publicKey: string
	privateKey: string
	subject: string
}

export interface WebPushTarget {
	endpoint: string
	keys: { p256dh: string; auth: string }
}

export interface WebPushSendOptions {
	/** Seconds the push service may hold the message while the browser is offline. */
	ttl: number
	urgency: 'very-low' | 'low' | 'normal' | 'high'
	/** Replaces an earlier undelivered message with the same topic (≤32 URL-safe chars). */
	topic: string
}

export interface WebPushTransport {
	/** Resolves with the push service's status code; rejects only on network failure. */
	send(
		config: WebPushConfig,
		target: WebPushTarget,
		payload: string,
		options: WebPushSendOptions,
	): Promise<{ status: number }>
}

/** What `sw.js` receives. Keep in sync with `apps/web/public/sw.js`. */
export interface WebPushPayload {
	title: string
	body?: string
	/** Same-origin path the click opens, e.g. `/<workspaceId>/chats/<id>`. */
	url: string
	tag: string
	/** Passive notifications arrive without sound/vibration. */
	silent: boolean
	/** Decisions and anything waiting on the person stay on screen until acted on. */
	requireInteraction: boolean
}

const TITLE_MAX = 100
const BODY_MAX = 200
const TTL_SECONDS = 24 * 60 * 60
const REQUEST_TIMEOUT_MS = 10_000

export function loadWebPushConfig(env: NodeJS.ProcessEnv = process.env): WebPushConfig | null {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim()
	const privateKey = env.VAPID_PRIVATE_KEY?.trim()
	const subject = env.VAPID_SUBJECT?.trim()
	if (!publicKey || !privateKey || !subject) return null
	if (!/^(mailto:|https:\/\/)/.test(subject)) return null
	return { publicKey, privateKey, subject }
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The same targets the native deep links name, as paths the web app routes. */
export function webUrlFor(msg: PushMessage): string {
	if (msg.conversationId) {
		const base = `/${msg.workspaceId}/chats/${msg.conversationId}`
		const root = msg.threadRootId
		return typeof root === 'number' && Number.isSafeInteger(root) && root > 0
			? `${base}?thread=${root}`
			: base
	}
	if (msg.objectId) return `/${msg.workspaceId}/objects/${msg.objectId}`
	return `/${msg.workspaceId}/notifications`
}

export function buildWebPushPayload(msg: PushMessage): WebPushPayload {
	const interruption = msg.interruption ?? (msg.decision ? 'time-sensitive' : 'active')
	return {
		title: truncate(msg.title, TITLE_MAX),
		...(msg.body ? { body: truncate(msg.body, BODY_MAX) } : {}),
		url: webUrlFor(msg),
		tag: msg.collapseKey?.trim() || msg.notificationId,
		silent: interruption === 'passive',
		requireInteraction: interruption === 'time-sensitive',
	}
}

/** A collapse key is arbitrary text, so it is hashed down to a valid topic (stable per key). */
export function webPushTopic(msg: PushMessage): string {
	const key = msg.collapseKey?.trim()
	if (key) return createHash('sha256').update(key).digest('hex').slice(0, 32)
	return msg.notificationId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
}

export function buildWebPushOptions(msg: PushMessage): WebPushSendOptions {
	const interruption = msg.interruption ?? (msg.decision ? 'time-sensitive' : 'active')
	return {
		ttl: TTL_SECONDS,
		urgency:
			interruption === 'time-sensitive' ? 'high' : interruption === 'passive' ? 'low' : 'normal',
		// RFC 8030 topics are ≤32 URL-safe characters; a uuid without its hyphens is exactly 32.
		topic: webPushTopic(msg),
	}
}

/** Real transport: `web-push` handles VAPID signing and RFC 8291 payload encryption. */
export class WebPushLibTransport implements WebPushTransport {
	async send(
		config: WebPushConfig,
		target: WebPushTarget,
		payload: string,
		options: WebPushSendOptions,
	): Promise<{ status: number }> {
		try {
			const res = await webpush.sendNotification(target, payload, {
				vapidDetails: {
					subject: config.subject,
					publicKey: config.publicKey,
					privateKey: config.privateKey,
				},
				TTL: options.ttl,
				urgency: options.urgency,
				topic: options.topic,
				timeout: REQUEST_TIMEOUT_MS,
			})
			return { status: res.statusCode }
		} catch (err) {
			// web-push rejects on any non-2xx with the status attached; surface it as a result.
			const statusCode = (err as { statusCode?: unknown }).statusCode
			if (typeof statusCode === 'number') return { status: statusCode }
			throw err
		}
	}
}

export interface WebPushSenderOptions {
	/** Defaults to `loadWebPushConfig()`. Pass `null` to force disabled. */
	config?: WebPushConfig | null
	transport?: WebPushTransport
}

export class WebPushSender implements PushChannel {
	private config: WebPushConfig | null
	private transport: WebPushTransport
	private warnedDisabled = false

	constructor(
		private db: Database,
		opts: WebPushSenderOptions = {},
	) {
		this.config = opts.config === undefined ? loadWebPushConfig() : opts.config
		this.transport = opts.transport ?? new WebPushLibTransport()
	}

	isEnabled(): boolean {
		if (this.config) return true
		if (!this.warnedDisabled) {
			this.warnedDisabled = true
			logger.info(
				'Web Push disabled — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT unset, or the subject is not mailto:/https://',
			)
		}
		return false
	}

	/** The VAPID public key the browser subscribes with; null when push is not configured. */
	publicKey(): string | null {
		return this.config?.publicKey ?? null
	}

	/** Push to every browser the actor has subscribed. Never throws. */
	async sendToActor(actorId: string, msg: PushMessage): Promise<void> {
		const config = this.config
		if (!this.isEnabled() || !config) return
		try {
			const subs = await this.db
				.select()
				.from(webPushSubscriptions)
				.where(eq(webPushSubscriptions.actorId, actorId))
			if (subs.length === 0) return

			const payload = JSON.stringify(buildWebPushPayload(msg))
			const options = buildWebPushOptions(msg)

			await Promise.all(
				subs.map(async (sub) => {
					// Re-checked at send time: rows stored before the allowlist, or written some other
					// way, must never make the server call an arbitrary host. Drop them.
					if (!isAllowedWebPushEndpoint(sub.endpoint)) {
						await this.db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.id, sub.id))
						logger.warn('Web Push subscription has a non-push-service endpoint, removed', {
							subscriptionId: sub.id,
						})
						return
					}
					try {
						const res = await this.transport.send(
							config,
							{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
							payload,
							options,
						)
						if (res.status >= 200 && res.status < 300) return
						if (res.status === 404 || res.status === 410) {
							await this.db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.id, sub.id))
							logger.info('Web Push subscription gone, removed', {
								subscriptionId: sub.id,
								status: res.status,
							})
							return
						}
						// Never log the endpoint: it is a bearer capability to push to this browser.
						logger.warn('Web Push rejected', { subscriptionId: sub.id, status: res.status })
					} catch (err) {
						logger.warn('Web Push failed', { subscriptionId: sub.id, error: String(err) })
					}
				}),
			)
		} catch (err) {
			logger.warn('Web Push sendToActor failed', { actorId, error: String(err) })
		}
	}
}
