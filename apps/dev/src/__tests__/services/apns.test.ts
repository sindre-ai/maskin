import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
	APNS_PAYLOAD_MAX_BYTES,
	type ApnsConfig,
	type ApnsRequest,
	ApnsSender,
	type ApnsTransport,
	DECISION_CATEGORY,
	buildApnsPayload,
	deepLinkFor,
	loadApnsConfig,
	signApnsJwt,
} from '../../services/apns'
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
	it('prefers the chat for deep link and thread, and falls back to the inbox', () => {
		expect(deepLinkFor({ ...msg, conversationId: 'c-1' })).toBe('maskin://ws-1/chats/c-1')
		expect(buildApnsPayload({ ...msg, conversationId: 'c-1' }).aps).toMatchObject({
			'thread-id': 'chat:c-1',
		})
		expect(deepLinkFor({ ...msg, objectId: null })).toBe('maskin://ws-1/notifications')
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

	it('caps options at three, truncates labels and drops an out-of-range recommended', () => {
		const p = buildApnsPayload({
			...msg,
			decision: {
				eventId: 1,
				options: [{ label: 'x'.repeat(200) }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
				recommended: 3,
			},
		}) as { decision: { options: { label: string }[]; recommended?: number } }
		expect(p.decision.options).toHaveLength(3)
		expect(p.decision.options[0]?.label.length).toBeLessThanOrEqual(40)
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
