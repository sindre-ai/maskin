import { describe, expect, it, vi } from 'vitest'
import type { PushMessage } from '../../services/push-types'
import {
	type WebPushConfig,
	WebPushSender,
	type WebPushTransport,
	buildWebPushOptions,
	buildWebPushPayload,
	loadWebPushConfig,
	webUrlFor,
} from '../../services/web-push'

const config: WebPushConfig = {
	publicKey: 'BPublicKeyPublicKeyPublicKeyPublicKeyPublicKey',
	privateKey: 'privateKeyprivateKeyprivateKey',
	subject: 'mailto:ops@example.com',
}

const sub = (over: Record<string, unknown> = {}) => ({
	id: 'sub-1',
	actorId: 'actor-1',
	endpoint: 'https://fcm.googleapis.com/send/abc',
	p256dh: 'p256dhKey',
	auth: 'authKey',
	userAgent: null,
	createdAt: new Date(),
	lastSeenAt: new Date(),
	...over,
})

const msg: PushMessage = {
	title: 'Bet shipped',
	body: 'Details',
	workspaceId: 'ws-1',
	notificationId: '0b6c1f4e-8a3d-4c53-9d3e-2f1a7b9c0d11',
}

function setup(rows: unknown[], transport: WebPushTransport, cfg: WebPushConfig | null = config) {
	const del = vi.fn()
	const db = {
		select: () => ({ from: () => ({ where: async () => rows }) }),
		delete: () => ({
			where: async () => {
				del()
			},
		}),
	} as never
	return { sender: new WebPushSender(db, { config: cfg, transport }), del }
}

describe('loadWebPushConfig', () => {
	it('returns null unless all three VAPID vars are set', () => {
		expect(loadWebPushConfig({})).toBeNull()
		expect(loadWebPushConfig({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' })).toBeNull()
	})

	it('rejects a subject that is neither mailto: nor https://', () => {
		const env = { VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', VAPID_SUBJECT: 'ops@example.com' }
		expect(loadWebPushConfig(env)).toBeNull()
		expect(loadWebPushConfig({ ...env, VAPID_SUBJECT: 'mailto:ops@example.com' })).toMatchObject({
			subject: 'mailto:ops@example.com',
		})
	})
})

describe('buildWebPushPayload', () => {
	it('opens the chat, object or notifications inbox, same-origin', () => {
		expect(webUrlFor({ ...msg, conversationId: 'c1', objectId: 'o1' })).toBe('/ws-1/chats/c1')
		expect(webUrlFor({ ...msg, objectId: 'o1' })).toBe('/ws-1/objects/o1')
		expect(webUrlFor(msg)).toBe('/ws-1/notifications')
	})

	it('uses the notification id as the tag so duplicates collapse', () => {
		expect(buildWebPushPayload(msg).tag).toBe(msg.notificationId)
	})

	it('truncates long text', () => {
		const p = buildWebPushPayload({ ...msg, title: 't'.repeat(500), body: 'b'.repeat(500) })
		expect(p.title.length).toBeLessThanOrEqual(100)
		expect(p.body?.length).toBeLessThanOrEqual(200)
	})

	it('keeps decisions on screen and passive pushes silent', () => {
		const decision = { eventId: 1, options: [{ label: 'Yes' }] }
		expect(buildWebPushPayload({ ...msg, decision })).toMatchObject({ requireInteraction: true })
		expect(buildWebPushPayload({ ...msg, interruption: 'passive' })).toMatchObject({
			silent: true,
			requireInteraction: false,
		})
	})

	it('never carries the decision options (native-only)', () => {
		const decision = { eventId: 1, options: [{ label: 'Yes' }] }
		expect(JSON.stringify(buildWebPushPayload({ ...msg, decision }))).not.toContain('Yes')
	})
})

describe('buildWebPushOptions', () => {
	it('maps interruption to urgency and builds a 32-char topic from a uuid', () => {
		expect(buildWebPushOptions({ ...msg, interruption: 'time-sensitive' }).urgency).toBe('high')
		expect(buildWebPushOptions({ ...msg, interruption: 'passive' }).urgency).toBe('low')
		expect(buildWebPushOptions(msg).urgency).toBe('normal')
		expect(buildWebPushOptions(msg).topic).toBe('0b6c1f4e8a3d4c539d3e2f1a7b9c0d11')
	})
})

describe('WebPushSender', () => {
	it('is disabled and sends nothing without config', async () => {
		const transport = { send: vi.fn() }
		const { sender } = setup([sub()], transport, null)
		expect(sender.isEnabled()).toBe(false)
		expect(sender.publicKey()).toBeNull()
		await sender.sendToActor('actor-1', msg)
		expect(transport.send).not.toHaveBeenCalled()
	})

	it('sends to every subscription with the stored keys', async () => {
		const transport = { send: vi.fn().mockResolvedValue({ status: 201 }) }
		const { sender } = setup(
			[sub(), sub({ id: 'sub-2', endpoint: 'https://fcm.googleapis.com/2' })],
			transport,
		)
		await sender.sendToActor('actor-1', msg)
		expect(transport.send).toHaveBeenCalledTimes(2)
		const [, target, body] = transport.send.mock.calls[0] ?? []
		expect(target).toEqual({
			endpoint: 'https://fcm.googleapis.com/send/abc',
			keys: { p256dh: 'p256dhKey', auth: 'authKey' },
		})
		expect(JSON.parse(body)).toMatchObject({ title: 'Bet shipped', url: '/ws-1/notifications' })
	})

	it('never calls a stored endpoint that is not a push service, and removes the row', async () => {
		const transport = { send: vi.fn().mockResolvedValue({ status: 201 }) }
		const { sender, del } = setup(
			[sub({ endpoint: 'https://169.254.169.254/latest/meta-data' })],
			transport,
		)
		await sender.sendToActor('actor-1', msg)
		expect(transport.send).not.toHaveBeenCalled()
		expect(del).toHaveBeenCalled()
	})

	it.each([404, 410])('deletes the subscription on %i', async (status) => {
		const transport = { send: vi.fn().mockResolvedValue({ status }) }
		const { sender, del } = setup([sub()], transport)
		await sender.sendToActor('actor-1', msg)
		expect(del).toHaveBeenCalledTimes(1)
	})

	it('keeps the subscription on a 5xx or a network error, and never throws', async () => {
		const transport = {
			send: vi
				.fn()
				.mockResolvedValueOnce({ status: 503 })
				.mockRejectedValueOnce(new Error('socket hang up')),
		}
		const { sender, del } = setup([sub(), sub({ id: 'sub-2' })], transport)
		await expect(sender.sendToActor('actor-1', msg)).resolves.toBeUndefined()
		expect(del).not.toHaveBeenCalled()
	})
})
