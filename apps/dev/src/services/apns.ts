/**
 * APNs sender — token-based (p8) auth over HTTP/2, no third-party dependency.
 *
 * Config (all read from env; if any of the first three is missing the sender is
 * DISABLED — it logs once and every send is a silent no-op, never a throw):
 *   APNS_KEY_ID       10-char key id of the .p8 key
 *   APNS_TEAM_ID      Apple developer team id
 *   APNS_PRIVATE_KEY  contents of the .p8 file (literal "\n" escapes accepted)
 *   APNS_BUNDLE_ID    apns-topic, default `io.maskin.app`
 *
 * Deep links (custom `deep_link` key in the payload root, consumed by the apps):
 *   maskin://<workspaceId>/objects/<objectId>        a notification about an object
 *   maskin://<workspaceId>/chats/<conversationId>    a notification about a chat
 *   maskin://<workspaceId>/notifications             fallback: open the inbox / For You
 * `aps.thread-id` groups pushes per chat (`chat:<id>`), per object
 * (`object:<id>`) or per workspace (`workspace:<id>`). `aps.mutable-content = 1`
 * so a notification service extension may rewrite the alert. The notification
 * id travels as `notification_id` and as `apns-collapse-id`, so a duplicate
 * delivery (e.g. two server replicas both fanning out one event) collapses on
 * the device.
 *
 * Actionable decisions: a `PushMessage.decision` adds `aps.category = DECISION_CATEGORY`
 * and a compact root `decision` object the app's notification service extension turns into
 * per-notification action buttons (iOS only lets an app register fixed categories ahead of
 * time, but option labels differ per notification):
 *   decision: { eventId, parentEventId?, objectId?, options: [{ label }], recommended? }
 * `eventId` is the agent's decision comment (what the reply threads under and the high-water
 * mark for mark-read); `recommended` is the zero-based index into `options`. Labels are
 * truncated, at most `DECISION_OPTIONS_MAX` options travel, and nothing secret is ever in it.
 * Rich pushes: `aps.interruption-level` (`time-sensitive` for decisions, `active` otherwise,
 * `passive` when asked), `aps.badge` (the actor's pending-notification count) and an optional
 * root `image_url` (https only) the extension downloads and attaches. `buildApnsPayload` is the
 * single place that writes these keys; the extension reads exactly them.
 * The whole payload is held under APNs' 4 KB limit (see `buildApnsPayload`).
 *
 * Live Activities: `buildLiveActivityPayload` + `ApnsSender.sendLiveActivity` push ActivityKit
 * start/update/end with `apns-push-type: liveactivity` and topic `<bundle>.push-type.liveactivity`.
 *
 * A 410 or a 400 BadDeviceToken / 410 Unregistered response deletes the token
 * row, so dead devices stop being targeted.
 */
import { createPrivateKey, sign } from 'node:crypto'
import { type ClientHttp2Session, connect } from 'node:http2'
import type { Database } from '@maskin/db'
import { deviceTokens } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'

export interface ApnsConfig {
	keyId: string
	teamId: string
	privateKey: string
	bundleId: string
}

export interface ApnsRequest {
	host: string
	token: string
	headers: Record<string, string>
	body: string
}

export interface ApnsResponse {
	status: number
	body: string
}

export interface ApnsTransport {
	send(req: ApnsRequest): Promise<ApnsResponse>
}

export interface PushDecision {
	/** The agent's decision comment (events.id). */
	eventId: number
	/** The comment's own parent, when the decision was posted as a reply. */
	parentEventId?: number | null
	objectId?: string | null
	options: { label: string }[]
	/** Zero-based index into `options` of the recommended choice. */
	recommended?: number | null
}

export interface PushMessage {
	title: string
	body?: string | null
	workspaceId: string
	notificationId: string
	objectId?: string | null
	conversationId?: string | null
	decision?: PushDecision | null
	/** Banner behaviour: `time-sensitive` breaks through Focus (decisions), `passive` is silent. */
	interruption?: PushInterruption
	/** App-icon badge to show (the actor's pending notifications); omitted leaves it untouched. */
	badge?: number | null
	/** https image the notification service extension downloads and attaches to the banner. */
	imageUrl?: string | null
}

export type PushInterruption = 'time-sensitive' | 'active' | 'passive'

export const APNS_HOSTS = {
	production: 'api.push.apple.com',
	sandbox: 'api.sandbox.push.apple.com',
} as const

const JWT_TTL_MS = 50 * 60 * 1000
const IMAGE_URL_MAX = 500
const BODY_MAX = 200
const TITLE_MAX = 100
const REQUEST_TIMEOUT_MS = 10_000
/** APNs rejects alert payloads over 4096 bytes; keep headroom for header-ish overhead. */
export const APNS_PAYLOAD_MAX_BYTES = 3800
/** Static category registered by the app as a fallback; the extension swaps in a per-push one. */
export const DECISION_CATEGORY = 'maskin.decision'
/** One banner shows at most four actions; one slot is the Reply field. */
export const DECISION_OPTIONS_MAX = 3
export const DECISION_LABEL_MAX = 40

export function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
	const keyId = env.APNS_KEY_ID?.trim()
	const teamId = env.APNS_TEAM_ID?.trim()
	const privateKey = env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n').trim()
	if (!keyId || !teamId || !privateKey) return null
	return { keyId, teamId, privateKey, bundleId: env.APNS_BUNDLE_ID?.trim() || 'io.maskin.app' }
}

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url')
}

/** ES256 provider token. JOSE requires the raw r||s form, hence ieee-p1363. */
export function signApnsJwt(config: ApnsConfig, issuedAtSeconds: number): string {
	const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
	const claims = b64url(JSON.stringify({ iss: config.teamId, iat: issuedAtSeconds }))
	const signingInput = `${header}.${claims}`
	const signature = sign('sha256', Buffer.from(signingInput), {
		key: createPrivateKey(config.privateKey),
		dsaEncoding: 'ieee-p1363',
	})
	return `${signingInput}.${b64url(signature)}`
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function deepLinkFor(msg: PushMessage): string {
	if (msg.conversationId) return `maskin://${msg.workspaceId}/chats/${msg.conversationId}`
	if (msg.objectId) return `maskin://${msg.workspaceId}/objects/${msg.objectId}`
	return `maskin://${msg.workspaceId}/notifications`
}

function compactDecision(decision: PushDecision): Record<string, unknown> | null {
	const options = decision.options
		.map((o) => ({ label: truncate(o.label.trim(), DECISION_LABEL_MAX) }))
		.filter((o) => o.label.length > 0)
		.slice(0, DECISION_OPTIONS_MAX)
	// A decision with no choices is just a notification; the Reply field alone needs no payload.
	if (options.length === 0 || !Number.isSafeInteger(decision.eventId)) return null
	const recommended =
		typeof decision.recommended === 'number' &&
		decision.recommended >= 0 &&
		decision.recommended < options.length
			? decision.recommended
			: undefined
	return {
		eventId: decision.eventId,
		...(decision.parentEventId != null ? { parentEventId: decision.parentEventId } : {}),
		...(decision.objectId ? { objectId: decision.objectId } : {}),
		options,
		...(recommended !== undefined ? { recommended } : {}),
	}
}

/** Only https URLs of sane length travel; the extension refuses anything else anyway. */
function safeImageUrl(url: string | null | undefined): string | null {
	if (!url || url.length > IMAGE_URL_MAX) return null
	try {
		return new URL(url).protocol === 'https:' ? url : null
	} catch {
		return null
	}
}

const byteLength = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload), 'utf8')

export function buildApnsPayload(msg: PushMessage): Record<string, unknown> {
	const threadId = msg.conversationId
		? `chat:${msg.conversationId}`
		: msg.objectId
			? `object:${msg.objectId}`
			: `workspace:${msg.workspaceId}`
	const decision = msg.decision ? compactDecision(msg.decision) : null
	const interruption = msg.interruption ?? (decision ? 'time-sensitive' : 'active')
	const badge =
		typeof msg.badge === 'number' && Number.isSafeInteger(msg.badge) && msg.badge >= 0
			? msg.badge
			: undefined
	const imageUrl = safeImageUrl(msg.imageUrl)
	const build = (bodyMax: number, withDecision: boolean): Record<string, unknown> => ({
		aps: {
			alert: {
				title: truncate(msg.title, TITLE_MAX),
				...(msg.body ? { body: truncate(msg.body, bodyMax) } : {}),
			},
			'thread-id': threadId,
			'mutable-content': 1,
			...(interruption === 'passive' ? {} : { sound: 'default' }),
			'interruption-level': interruption,
			...(badge !== undefined ? { badge } : {}),
			...(withDecision && decision ? { category: DECISION_CATEGORY } : {}),
		},
		deep_link: deepLinkFor(msg),
		notification_id: msg.notificationId,
		workspace_id: msg.workspaceId,
		...(imageUrl ? { image_url: imageUrl } : {}),
		...(withDecision && decision ? { decision } : {}),
	})
	// Multi-byte text can push even a capped payload over the limit: shrink the body, and as a
	// last resort drop the decision (a plain, tappable notification beats a rejected push).
	for (const bodyMax of [BODY_MAX, 100, 40, 0]) {
		const payload = build(bodyMax, true)
		if (byteLength(payload) <= APNS_PAYLOAD_MAX_BYTES) return payload
	}
	return build(BODY_MAX, false)
}

// ── Live Activities ──────────────────────────────────────────────────────

/** The Swift `ActivityAttributes` type the push-to-start payload instantiates. */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'MaskinTurnAttributes'
export const LIVE_ACTIVITY_STEP_MAX = 80
export const LIVE_ACTIVITY_AGENT_NAME_MAX = 40
/** Seconds between the Unix epoch and Swift's reference date (2001-01-01T00:00:00Z). */
const SWIFT_REFERENCE_DATE_OFFSET_S = 978_307_200

export type LiveActivityStatus = 'running' | 'needsYou' | 'done' | 'failed'
export type LiveActivityEvent = 'start' | 'update' | 'end'

export interface LiveActivityContentState {
	sessionId: string
	agentName: string
	step: string
	/** Seconds since 2001-01-01T00:00:00Z — Swift's default `Date` Codable encoding. */
	startedAt: number
	status: LiveActivityStatus
}

export interface LiveActivityPush {
	event: LiveActivityEvent
	sessionId: string
	workspaceId: string
	conversationId?: string | null
	agentName: string
	step?: string | null
	startedAt: Date
	status: LiveActivityStatus
	/** Optional alert shown with the update so it buzzes (needsYou). */
	alert?: { title: string; body?: string | null } | null
}

export const toSwiftReferenceSeconds = (d: Date): number =>
	d.getTime() / 1000 - SWIFT_REFERENCE_DATE_OFFSET_S

function defaultStep(status: LiveActivityStatus): string {
	switch (status) {
		case 'needsYou':
			return 'Needs you'
		case 'done':
			return 'Done'
		case 'failed':
			return 'Failed'
		default:
			return 'Working'
	}
}

export function buildLiveActivityPayload(
	push: LiveActivityPush,
	nowMs: number,
): Record<string, unknown> {
	const contentState: LiveActivityContentState = {
		sessionId: push.sessionId,
		agentName: truncate(push.agentName, LIVE_ACTIVITY_AGENT_NAME_MAX),
		step: truncate((push.step ?? '').trim() || defaultStep(push.status), LIVE_ACTIVITY_STEP_MAX),
		startedAt: toSwiftReferenceSeconds(push.startedAt),
		status: push.status,
	}
	const timestamp = Math.floor(nowMs / 1000)
	const aps: Record<string, unknown> = {
		timestamp,
		event: push.event,
		'content-state': contentState,
	}
	if (push.event === 'start') {
		aps['attributes-type'] = LIVE_ACTIVITY_ATTRIBUTES_TYPE
		aps.attributes = {
			sessionId: push.sessionId,
			workspaceId: push.workspaceId,
			...(push.conversationId ? { conversationId: push.conversationId } : {}),
		}
		// A start push must carry an alert (iOS shows it as the banner that begins the activity).
		aps.alert = {
			title: truncate(push.agentName, TITLE_MAX),
			body: truncate(contentState.step, BODY_MAX),
		}
	} else if (push.alert) {
		aps.alert = {
			title: truncate(push.alert.title, TITLE_MAX),
			...(push.alert.body ? { body: truncate(push.alert.body, BODY_MAX) } : {}),
		}
	}
	if (push.event === 'end') {
		// Leave the final state visible briefly, then dismiss.
		aps['dismissal-date'] = timestamp + (push.status === 'failed' ? 600 : 120)
	} else {
		// If updates stop arriving (server down), mark the activity stale after 15 minutes.
		aps['stale-date'] = timestamp + 15 * 60
	}
	return { aps }
}

export interface LiveActivityTarget {
	token: string
	environment: string
}

export type LiveActivityResult = 'sent' | 'dead' | 'failed' | 'disabled'

/** Real transport: one pooled HTTP/2 session per APNs host. */
export class Http2ApnsTransport implements ApnsTransport {
	private sessions = new Map<string, ClientHttp2Session>()

	private sessionFor(host: string): ClientHttp2Session {
		const existing = this.sessions.get(host)
		if (existing && !existing.closed && !existing.destroyed) return existing
		const session = connect(`https://${host}`)
		const drop = () => {
			if (this.sessions.get(host) === session) this.sessions.delete(host)
		}
		session.on('error', drop)
		session.on('close', drop)
		session.on('goaway', drop)
		session.unref()
		this.sessions.set(host, session)
		return session
	}

	send(req: ApnsRequest): Promise<ApnsResponse> {
		return new Promise((resolve, reject) => {
			let stream: ReturnType<ClientHttp2Session['request']>
			try {
				stream = this.sessionFor(req.host).request({
					':method': 'POST',
					':path': `/3/device/${req.token}`,
					...req.headers,
				})
			} catch (err) {
				reject(err)
				return
			}
			let status = 0
			let body = ''
			stream.setEncoding('utf8')
			stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
				stream.close()
				reject(new Error('APNs request timed out'))
			})
			stream.on('response', (headers) => {
				status = Number(headers[':status'] ?? 0)
			})
			stream.on('data', (chunk) => {
				body += chunk
			})
			stream.on('end', () => resolve({ status, body }))
			stream.on('error', reject)
			stream.end(req.body)
		})
	}

	close() {
		for (const s of this.sessions.values()) s.close()
		this.sessions.clear()
	}
}

export interface ApnsSenderOptions {
	/** Defaults to `loadApnsConfig()`. Pass `null` to force disabled. */
	config?: ApnsConfig | null
	transport?: ApnsTransport
	now?: () => number
}

export class ApnsSender {
	private config: ApnsConfig | null
	private transport: ApnsTransport
	private now: () => number
	private jwt: { token: string; issuedAtMs: number } | null = null
	private warnedDisabled = false

	constructor(
		private db: Database,
		opts: ApnsSenderOptions = {},
	) {
		this.config = opts.config === undefined ? loadApnsConfig() : opts.config
		this.transport = opts.transport ?? new Http2ApnsTransport()
		this.now = opts.now ?? Date.now
	}

	isEnabled(): boolean {
		if (this.config) return true
		if (!this.warnedDisabled) {
			this.warnedDisabled = true
			logger.info('APNs push disabled — APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY not set')
		}
		return false
	}

	private providerToken(config: ApnsConfig): string {
		const nowMs = this.now()
		if (!this.jwt || nowMs - this.jwt.issuedAtMs > JWT_TTL_MS) {
			this.jwt = { token: signApnsJwt(config, Math.floor(nowMs / 1000)), issuedAtMs: nowMs }
		}
		return this.jwt.token
	}

	/** One Live Activity push to one ActivityKit token. Never throws; 'dead' = drop the token. */
	async sendLiveActivity(
		target: LiveActivityTarget,
		push: LiveActivityPush,
	): Promise<LiveActivityResult> {
		const config = this.config
		if (!this.isEnabled() || !config) return 'disabled'
		try {
			const res = await this.transport.send({
				host: APNS_HOSTS[target.environment === 'production' ? 'production' : 'sandbox'],
				token: target.token,
				headers: {
					authorization: `bearer ${this.providerToken(config)}`,
					'apns-topic': `${config.bundleId}.push-type.liveactivity`,
					'apns-push-type': 'liveactivity',
					// Routine step updates are budgeted by iOS at low priority; start/end and
					// anything that should buzz go out immediately.
					'apns-priority': push.event === 'update' && !push.alert ? '5' : '10',
					'content-type': 'application/json',
				},
				body: JSON.stringify(buildLiveActivityPayload(push, this.now())),
			})
			if (res.status === 200) return 'sent'
			const reason = parseReason(res.body)
			if (isDeadToken(res.status, reason)) return 'dead'
			logger.warn('APNs live activity push rejected', {
				sessionId: push.sessionId,
				event: push.event,
				status: res.status,
				reason,
			})
			return 'failed'
		} catch (err) {
			logger.warn('APNs live activity push failed', {
				sessionId: push.sessionId,
				error: String(err),
			})
			return 'failed'
		}
	}

	/** Push to every registered device of an actor. Never throws. */
	async sendToActor(actorId: string, msg: PushMessage): Promise<void> {
		const config = this.config
		if (!this.isEnabled() || !config) return
		try {
			const devices = await this.db
				.select()
				.from(deviceTokens)
				.where(eq(deviceTokens.actorId, actorId))
			if (devices.length === 0) return

			const body = JSON.stringify(buildApnsPayload(msg))
			const authorization = `bearer ${this.providerToken(config)}`

			await Promise.all(
				devices.map(async (device) => {
					try {
						const res = await this.transport.send({
							host: APNS_HOSTS[device.environment === 'production' ? 'production' : 'sandbox'],
							token: device.apnsToken,
							headers: {
								authorization,
								'apns-topic': config.bundleId,
								'apns-push-type': 'alert',
								'apns-priority': msg.interruption === 'passive' ? '5' : '10',
								'apns-collapse-id': msg.notificationId.slice(0, 64),
								'content-type': 'application/json',
							},
							body,
						})
						if (res.status === 200) return
						const reason = parseReason(res.body)
						if (isDeadToken(res.status, reason)) {
							await this.db
								.delete(deviceTokens)
								.where(
									and(
										eq(deviceTokens.apnsToken, device.apnsToken),
										eq(deviceTokens.environment, device.environment),
									),
								)
							logger.info('APNs token unregistered, removed', { deviceId: device.id, reason })
							return
						}
						logger.warn('APNs push rejected', { deviceId: device.id, status: res.status, reason })
					} catch (err) {
						logger.warn('APNs push failed', { deviceId: device.id, error: String(err) })
					}
				}),
			)
		} catch (err) {
			logger.warn('APNs sendToActor failed', { actorId, error: String(err) })
		}
	}
}

function parseReason(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { reason?: unknown }
		return typeof parsed.reason === 'string' ? parsed.reason : undefined
	} catch {
		return undefined
	}
}

function isDeadToken(status: number, reason: string | undefined): boolean {
	return status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken'
}
