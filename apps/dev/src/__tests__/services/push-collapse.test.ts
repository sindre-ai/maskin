import { describe, expect, it } from 'vitest'
import { APNS_COLLAPSE_ID_MAX_BYTES, apnsCollapseId, buildApnsPayload } from '../../services/apns'
import type { PushMessage } from '../../services/push-types'
import { buildWebPushOptions, buildWebPushPayload } from '../../services/web-push'

const msg = (over: Partial<PushMessage> = {}): PushMessage => ({
	title: 'Hi',
	workspaceId: 'ws',
	notificationId: 'n-1',
	conversationId: 'c-1',
	...over,
})

describe('collapse keys', () => {
	it('APNs: collapse id and thread-id use the key; fall back to the notification id', () => {
		expect(apnsCollapseId(msg({ collapseKey: 'chat:abc' }))).toBe('chat:abc')
		expect(apnsCollapseId(msg())).toBe('n-1')
		const aps = buildApnsPayload(msg({ collapseKey: 'foryou:ws' })).aps as Record<string, unknown>
		expect(aps['thread-id']).toBe('foryou:ws')
		const legacy = buildApnsPayload(msg()).aps as Record<string, unknown>
		expect(legacy['thread-id']).toBe('chat:c-1')
	})

	it('APNs: hashes a key over 64 bytes into a stable id within the limit', () => {
		const long = `chat:${'x'.repeat(100)}`
		const a = apnsCollapseId(msg({ collapseKey: long }))
		expect(Buffer.byteLength(a)).toBeLessThanOrEqual(APNS_COLLAPSE_ID_MAX_BYTES)
		expect(apnsCollapseId(msg({ collapseKey: long }))).toBe(a)
		expect(apnsCollapseId(msg({ collapseKey: `${long}y` }))).not.toBe(a)
	})

	it('APNs: passive drops the sound and stays under the payload limit with a long key', () => {
		const p = buildApnsPayload(msg({ collapseKey: 'k'.repeat(500), interruption: 'passive' }))
		const aps = p.aps as Record<string, unknown>
		expect(aps.sound).toBeUndefined()
		expect(aps['interruption-level']).toBe('passive')
		expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(4096)
	})

	it('Web Push: tag is the key and topic a valid hash of it', () => {
		expect(buildWebPushPayload(msg({ collapseKey: 'chat:abc' })).tag).toBe('chat:abc')
		expect(buildWebPushPayload(msg()).tag).toBe('n-1')
		const a = buildWebPushOptions(msg({ collapseKey: 'chat:abc' })).topic
		expect(a).toMatch(/^[0-9a-f]{32}$/)
		expect(buildWebPushOptions(msg({ collapseKey: 'chat:abc' })).topic).toBe(a)
		expect(buildWebPushOptions(msg({ collapseKey: 'chat:abd' })).topic).not.toBe(a)
	})
})
