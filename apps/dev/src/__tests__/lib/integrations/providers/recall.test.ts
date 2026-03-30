import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyRecallWebhook } from '../../../../lib/integrations/providers/recall/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Recall.ai provider', () => {
	describe('registry', () => {
		it('is registered and discoverable', () => {
			const provider = getProvider('recall')
			expect(provider.config.name).toBe('recall')
			expect(provider.config.displayName).toBe('Recall.ai')
			expect(provider.config.auth.type).toBe('api_key')
			expect(provider.customWebhookVerifier).toBeDefined()
		})

		it('is excluded from listProviders (internal provider)', () => {
			const names = listProviders().map((p) => p.config.name)
			expect(names).not.toContain('recall')
		})
	})

	describe('webhook verification', () => {
		const SECRET_RAW = Buffer.from('test-secret-key-1234567890')
		const SECRET = `whsec_${SECRET_RAW.toString('base64')}`

		function sign(msgId: string, timestamp: string, body: string): string {
			const toSign = `${msgId}.${timestamp}.${body}`
			const sig = createHmac('sha256', SECRET_RAW).update(toSign).digest('base64')
			return `v1,${sig}`
		}

		beforeEach(() => {
			vi.stubEnv('RECALL_WEBHOOK_SECRET', SECRET)
		})

		afterEach(() => {
			vi.unstubAllEnvs()
		})

		it('accepts a valid signature', () => {
			const body = '{"event":"bot.status_change"}'
			const msgId = 'msg_abc123'
			const timestamp = '1731705121'
			const signature = sign(msgId, timestamp, body)

			expect(
				verifyRecallWebhook(body, {
					'webhook-id': msgId,
					'webhook-timestamp': timestamp,
					'webhook-signature': signature,
				}),
			).toBe(true)
		})

		it('accepts legacy svix-* headers', () => {
			const body = '{"event":"bot.status_change"}'
			const msgId = 'msg_abc123'
			const timestamp = '1731705121'
			const signature = sign(msgId, timestamp, body)

			expect(
				verifyRecallWebhook(body, {
					'svix-id': msgId,
					'svix-timestamp': timestamp,
					'svix-signature': signature,
				}),
			).toBe(true)
		})

		it('rejects an invalid signature', () => {
			expect(
				verifyRecallWebhook('{"event":"test"}', {
					'webhook-id': 'msg_abc',
					'webhook-timestamp': '123',
					'webhook-signature': 'v1,invalidsignature==',
				}),
			).toBe(false)
		})

		it('rejects when headers are missing', () => {
			expect(verifyRecallWebhook('{}', {})).toBe(false)
		})

		it('rejects when secret is not set', () => {
			vi.stubEnv('RECALL_WEBHOOK_SECRET', '')

			expect(
				verifyRecallWebhook('{}', {
					'webhook-id': 'msg_abc',
					'webhook-timestamp': '123',
					'webhook-signature': 'v1,sig',
				}),
			).toBe(false)
		})

		it('handles multiple signatures in header', () => {
			const body = '{"data":"test"}'
			const msgId = 'msg_multi'
			const timestamp = '999'
			const validSig = sign(msgId, timestamp, body)

			expect(
				verifyRecallWebhook(body, {
					'webhook-id': msgId,
					'webhook-timestamp': timestamp,
					'webhook-signature': `v1,wrong== ${validSig}`,
				}),
			).toBe(true)
		})
	})
})
