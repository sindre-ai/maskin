import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
	APNS_PAYLOAD_MAX_BYTES,
	type ApnsConfig,
	type ApnsRequest,
	ApnsSender,
	type ApnsTransport,
	DECISION_CATEGORY,
	buildApnsClearPayload,
	buildApnsPayload,
	deepLinkFor,
	loadApnsConfig,
	signApnsJwt,
} from '../../services/apns'
import { CLEAR_IDS_MAX } from '../../services/push-types'
import { createTestContext } from '../setup'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const config: ApnsConfig = {
	keyId: 'ABC123DEFG',
	teamId: 'TEAM123456',
	privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
	bundleId: 'io.maskin.app',
}

const device = (over: Record<string, unknown> = {}) => ({
	id: 'dev-1',
	actorId: 'actor-1',
	platform: 'ios',
	apnsToken: 'ab'.repeat(32),
	environment: 'sandbox',
	appVersion: null,
	createdAt: new Date(),
	lastSeenAt: new Date(),
	...over,
})

const msg = {
	title: 'Bet shipped',
	body: 'Details',
	workspaceId: 'ws-1',
	notificationId: 'n-1',
	objectId: 'obj-1',
}

function setup(devices: unknown[], transport: ApnsTransport, cfg: ApnsConfig | null = config) {
	const { db, mockResults, calls } = createTestContext()
	mockResults.select = devices
	const sender = new ApnsSender(db, { config: cfg, transport })
	return { sender, mockResults, calls }
}

describe('signApnsJwt', () => {
	it('produces an ES256 JWT with kid/iss/iat and a verifiable p1363 signature', () => {
		const jwt = signApnsJwt(config, 1_700_000_000)
		const [h, c, s] = jwt.split('.') as [string, string, string]
		expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
			alg: 'ES256',
			kid: 'ABC123DEFG',
		})
		expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
			iss: 'TEAM123456',
			iat: 1_700_000_000,
		})
		const sig = Buffer.from(s, 'base64url')
		expect(sig).toHaveLength(64)
		expect(
			verify(
				'sha256',
				Buffer.from(`${h}.${c}`),
				{ key: publicKey, dsaEncoding: 'ieee-p1363' },
				sig,
			),
		).toBe(true)
	})
})

describe('loadApnsConfig', () => {
	it('returns null unless key id, team id and key are all set', () => {
		expect(loadApnsConfig({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't' })).toBeNull()
	})
	it('defaults the bundle id and unescapes newlines', () => {
		const c = loadApnsConfig({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'a\\nb' })
		expect(c).toMatchObject({ bundleId: 'io.maskin.app', privateKey: 'a\nb' })
	})
})

describe('buildApnsPayload', () => {
	it('carries alert, thread-id, mutable-content and deep_link', () => {
		expect(buildApnsPayload(msg)).toMatchObject({
			aps: {
				alert: { title: 'Bet shipped', body: 'Details' },
				'thread-id': 'object:obj-1',
				'mutable-content': 1,
			},
			deep_link: 'maskin://ws-1/objects/obj-1',
			notification_id: 'n-1',
		})
	})
	it('carries the notification type for the app to count an open, only when known', () => {
		expect(buildApnsPayload({ ...msg, notificationType: 'needs_input' })).toMatchObject({
			notification_id: 'n-1',
			notification_type: 'needs_input',
		})
		expect(buildApnsPayload(msg)).not.toHaveProperty('notification_type')
	})
	it('prefers the chat for deep link and thread, and falls back to the inbox', () => {
		expect(deepLinkFor({ ...msg, conversationId: 'c-1' })).toBe('maskin://ws-1/chats/c-1')
		expect(buildApnsPayload({ ...msg, conversationId: 'c-1' }).aps).toMatchObject({
			'thread-id': 'chat:c-1',
		})
		expect(deepLinkFor({ ...msg, objectId: null })).toBe('maskin://ws-1/notifications')
	})
	it('opens the thread inside the chat when the push is about a thread reply', () => {
		expect(deepLinkFor({ ...msg, conversationId: 'c-1', threadRootId: 42 })).toBe(
			'maskin://ws-1/chats/c-1?thread=42',
		)
	})
	it('ignores a thread id that is not a positive integer, and one with no chat', () => {
		expect(deepLinkFor({ ...msg, conversationId: 'c-1', threadRootId: 0 })).toBe(
			'maskin://ws-1/chats/c-1',
		)
		expect(deepLinkFor({ ...msg, conversationId: 'c-1', threadRootId: 1.5 })).toBe(
			'maskin://ws-1/chats/c-1',
		)
		expect(deepLinkFor({ ...msg, objectId: null, threadRootId: 42 })).toBe(
			'maskin://ws-1/notifications',
		)
	})
})

describe('buildApnsPayload rich fields', () => {
	const aps = (m: Record<string, unknown>) =>
		buildApnsPayload({ ...msg, ...m }).aps as Record<string, unknown>

	it('defaults to active, and to time-sensitive for a decision', () => {
		expect(aps({})['interruption-level']).toBe('active')
		const decision = { eventId: 1, options: [{ label: 'Ship' }] }
		expect(aps({ decision })['interruption-level']).toBe('time-sensitive')
		expect(aps({ decision, interruption: 'active' })['interruption-level']).toBe('active')
	})
	it('drops the sound for a passive push', () => {
		expect(aps({ interruption: 'passive' }).sound).toBeUndefined()
		expect(aps({})).toMatchObject({ sound: 'default' })
	})
	it('sends a valid badge, including zero, and ignores a bad one', () => {
		expect(aps({ badge: 3 }).badge).toBe(3)
		expect(aps({ badge: 0 }).badge).toBe(0)
		expect(aps({ badge: -1 })).not.toHaveProperty('badge')
		expect(aps({ badge: null })).not.toHaveProperty('badge')
	})
	it('carries only https image urls', () => {
		expect(buildApnsPayload({ ...msg, imageUrl: 'https://x.test/a.png' }).image_url).toBe(
			'https://x.test/a.png',
		)
		expect(buildApnsPayload({ ...msg, imageUrl: 'http://x.test/a.png' })).not.toHaveProperty(
			'image_url',
		)
		expect(buildApnsPayload({ ...msg, imageUrl: 'nope' })).not.toHaveProperty('image_url')
	})
})

describe('buildApnsPayload decision', () => {
	const decision = {
		eventId: 42,
		parentEventId: 7,
		objectId: 'obj-1',
		options: [{ label: '7-day window' }, { label: 'Hold' }],
		recommended: 0,
	}
	const size = (p: unknown) => Buffer.byteLength(JSON.stringify(p), 'utf8')

	it('adds the category hint and a compact decision object, keeping the deep link', () => {
		const p = buildApnsPayload({ ...msg, decision })
		expect(p).toMatchObject({
			aps: { category: DECISION_CATEGORY, 'mutable-content': 1 },
			deep_link: 'maskin://ws-1/objects/obj-1',
			decision,
		})
	})

	it('omits category and decision when there is none', () => {
		const p = buildApnsPayload(msg)
		expect(p).not.toHaveProperty('decision')
		expect((p.aps as Record<string, unknown>).category).toBeUndefined()
	})

	it('caps options at three and drops an out-of-range recommended', () => {
		const p = buildApnsPayload({
			...msg,
			decision: {
				eventId: 1,
				options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
				recommended: 3,
			},
		}) as { decision: { options: { label: string }[]; recommended?: number } }
		expect(p.decision.options).toHaveLength(3)
		expect(p.decision.recommended).toBeUndefined()
	})

	it('never truncates a label: an over-long one makes the decision non-actionable', () => {
		const p = buildApnsPayload({
			...msg,
			decision: { eventId: 1, options: [{ label: 'x'.repeat(200) }, { label: 'Hold' }] },
		})
		expect(p).not.toHaveProperty('decision')
		const ok = buildApnsPayload({
			...msg,
			decision: { eventId: 1, options: [{ label: 'x'.repeat(100) }, { label: 'Hold' }] },
		}) as { decision: { options: { label: string }[] } }
		expect(ok.decision.options[0]?.label).toBe('x'.repeat(100))
		expect(JSON.stringify(ok.decision)).not.toContain('\u2026')
	})

	it('passes destructive through only when true', () => {
		const p = buildApnsPayload({
			...msg,
			decision: {
				eventId: 1,
				options: [
					{ label: 'Send', destructive: true },
					{ label: 'Hold', destructive: false },
				],
			},
		}) as { decision: { options: Record<string, unknown>[] } }
		expect(p.decision.options[0]).toEqual({ label: 'Send', destructive: true })
		expect(p.decision.options[1]).toEqual({ label: 'Hold' })
	})

	it('remaps recommended after blank labels are filtered', () => {
		const p = buildApnsPayload({
			...msg,
			decision: {
				eventId: 1,
				options: [{ label: ' ' }, { label: 'Ship' }, { label: 'Hold' }],
				recommended: 2,
			},
		}) as { decision: { options: { label: string }[]; recommended?: number } }
		expect(p.decision.options.map((o) => o.label)).toEqual(['Ship', 'Hold'])
		expect(p.decision.recommended).toBe(1)
	})

	it('drops recommended when it points at a filtered-out blank', () => {
		const p = buildApnsPayload({
			...msg,
			decision: { eventId: 1, options: [{ label: ' ' }, { label: 'Ship' }], recommended: 0 },
		}) as { decision: { recommended?: number } }
		expect(p.decision.recommended).toBeUndefined()
	})

	it('sends no decision when no option survives', () => {
		const p = buildApnsPayload({ ...msg, decision: { eventId: 1, options: [{ label: '  ' }] } })
		expect(p).not.toHaveProperty('decision')
	})

	it('stays under the APNs limit with huge multi-byte text, keeping the decision', () => {
		const p = buildApnsPayload({
			...msg,
			title: '日本語'.repeat(200),
			body: '😀'.repeat(500),
			decision,
		})
		expect(size(p)).toBeLessThanOrEqual(APNS_PAYLOAD_MAX_BYTES)
		expect(p).toHaveProperty('decision')
	})

	it('contains no credential-shaped fields', () => {
		const text = JSON.stringify(buildApnsPayload({ ...msg, decision }))
		expect(text).not.toMatch(/ank_|token|secret|password/i)
	})
})

describe('ApnsSender', () => {
	it('is disabled and never throws or sends without config', async () => {
		const transport = { send: vi.fn() }
		const { sender } = setup([device()], transport, null)
		await expect(sender.sendToActor('actor-1', msg)).resolves.toBeUndefined()
		expect(transport.send).not.toHaveBeenCalled()
		expect(sender.isEnabled()).toBe(false)
	})

	it('sends to the sandbox host with the expected headers and caches the JWT', async () => {
		const sent: ApnsRequest[] = []
		const transport = {
			send: vi.fn(async (r: ApnsRequest) => {
				sent.push(r)
				return { status: 200, body: '' }
			}),
		}
		const { sender } = setup([device()], transport)
		await sender.sendToActor('actor-1', msg)
		await sender.sendToActor('actor-1', msg)
		expect(sent[0]).toMatchObject({
			host: 'api.sandbox.push.apple.com',
			headers: { 'apns-topic': 'io.maskin.app', 'apns-push-type': 'alert' },
		})
		expect(sent[0]?.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
		expect(sent[1]?.headers.authorization).toBe(sent[0]?.headers.authorization)
	})

	it('uses the production host for production tokens', async () => {
		const transport = { send: vi.fn(async () => ({ status: 200, body: '' })) }
		const { sender } = setup([device({ environment: 'production' })], transport)
		await sender.sendToActor('actor-1', msg)
		expect(transport.send.mock.calls[0]?.[0]).toMatchObject({ host: 'api.push.apple.com' })
	})

	it.each([
		[410, '{"reason":"Unregistered"}', 1],
		[400, '{"reason":"BadDeviceToken"}', 1],
		[400, '{"reason":"BadTopic"}', 0],
		[500, '', 0],
	])('status %i %s deletes the token %i times', async (status, body, expected) => {
		const del = vi.fn()
		const db = {
			select: () => ({ from: () => ({ where: async () => [device()] }) }),
			delete: () => ({
				where: async () => {
					del()
				},
			}),
		} as never
		const transport = { send: vi.fn(async () => ({ status, body })) }
		await new ApnsSender(db, { config, transport }).sendToActor('actor-1', msg)
		expect(del).toHaveBeenCalledTimes(expected)
	})

	it('swallows transport errors', async () => {
		const transport = {
			send: vi.fn(async () => {
				throw new Error('socket hang up')
			}),
		}
		const { sender } = setup([device()], transport)
		await expect(sender.sendToActor('actor-1', msg)).resolves.toBeUndefined()
	})
})

describe('buildApnsClearPayload', () => {
	it('is a silent background push with the ids, collapse key, thread and badge', () => {
		const p = buildApnsClearPayload({
			workspaceId: 'ws-1',
			notificationIds: ['n-1', 'n-2'],
			collapseKey: ' object:obj-1 ',
			threadId: 'chat:c-1',
			badge: 0,
		}) as { aps: Record<string, unknown>; clear: Record<string, unknown> }
		expect(p.aps).toEqual({ 'content-available': 1, badge: 0 })
		expect(p.aps.alert).toBeUndefined()
		expect(p.aps.sound).toBeUndefined()
		expect(p.clear).toEqual({
			notification_ids: ['n-1', 'n-2'],
			collapse_key: 'object:obj-1',
			thread_id: 'chat:c-1',
		})
	})

	it('caps the ids, drops a bad badge and omits empty optional keys', () => {
		const ids = Array.from({ length: CLEAR_IDS_MAX + 5 }, (_, i) => `n-${i}`)
		const p = buildApnsClearPayload({ workspaceId: 'ws-1', notificationIds: ids, badge: -1 }) as {
			aps: Record<string, unknown>
			clear: { notification_ids: string[] }
		}
		expect(p.clear.notification_ids).toHaveLength(CLEAR_IDS_MAX)
		expect(p.clear).not.toHaveProperty('collapse_key')
		expect(p.clear).not.toHaveProperty('thread_id')
		expect(p.aps).toEqual({ 'content-available': 1 })
	})

	it('stays far under the APNs limit at the id cap', () => {
		const ids = Array.from({ length: CLEAR_IDS_MAX }, () => crypto.randomUUID())
		const body = JSON.stringify(
			buildApnsClearPayload({ workspaceId: crypto.randomUUID(), notificationIds: ids, badge: 9 }),
		)
		expect(Buffer.byteLength(body)).toBeLessThan(APNS_PAYLOAD_MAX_BYTES)
	})
})

describe('ApnsSender.sendClearToActor', () => {
	const clear = { workspaceId: 'ws-1', notificationIds: ['n-1'], badge: 2 }

	it('sends a background, priority 5 push to every device with no alert', async () => {
		const sent: ApnsRequest[] = []
		const transport = {
			send: vi.fn(async (r: ApnsRequest) => {
				sent.push(r)
				return { status: 200, body: '' }
			}),
		}
		const { sender } = setup(
			[device(), device({ id: 'dev-2', environment: 'production' })],
			transport,
		)
		await sender.sendClearToActor('actor-1', clear)
		expect(sent).toHaveLength(2)
		expect(sent[0]?.headers).toMatchObject({
			'apns-push-type': 'background',
			'apns-priority': '5',
			'apns-topic': 'io.maskin.app',
		})
		expect(sent[0]?.headers['apns-collapse-id']).toBeUndefined()
		const body = JSON.parse(sent[0]?.body ?? '{}')
		expect(body.aps).toEqual({ 'content-available': 1, badge: 2 })
		expect(body.clear.notification_ids).toEqual(['n-1'])
		expect(sent[1]?.host).toBe('api.push.apple.com')
	})

	it('is a no-op without config, and swallows transport errors', async () => {
		const transport = { send: vi.fn() }
		await setup([device()], transport, null).sender.sendClearToActor('actor-1', clear)
		expect(transport.send).not.toHaveBeenCalled()
		const failing = {
			send: vi.fn(async () => {
				throw new Error('socket hang up')
			}),
		}
		await expect(
			setup([device()], failing).sender.sendClearToActor('actor-1', clear),
		).resolves.toBeUndefined()
	})

	it('removes a dead token like the alert path', async () => {
		const del = vi.fn()
		const db = {
			select: () => ({ from: () => ({ where: async () => [device()] }) }),
			delete: () => ({
				where: async () => {
					del()
				},
			}),
		} as never
		const transport = {
			send: vi.fn(async () => ({ status: 410, body: '{"reason":"Unregistered"}' })),
		}
		await new ApnsSender(db, { config, transport }).sendClearToActor('actor-1', clear)
		expect(del).toHaveBeenCalledTimes(1)
	})
})
