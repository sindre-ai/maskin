import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebhookConfig } from '../../../lib/integrations/types'
import { WebhookHandler } from '../../../lib/integrations/webhooks/handler'

// Mock getEnvOrThrow to return a known secret
vi.mock('../../../lib/integrations/env', () => ({
	getEnvOrThrow: vi.fn().mockReturnValue('webhook-secret'),
}))

describe('WebhookHandler', () => {
	const handler = new WebhookHandler()
	const body = '{"action":"push"}'

	describe('hmac-sha256 scheme', () => {
		const config: WebhookConfig = {
			signatureHeader: 'x-hub-signature-256',
			signatureScheme: 'hmac-sha256',
			signaturePrefix: 'sha256=',
			secretEnv: 'WEBHOOK_SECRET',
		}

		it('returns true for valid signature', () => {
			const digest = createHmac('sha256', 'webhook-secret').update(body).digest('hex')
			const signature = `sha256=${digest}`
			const headers = { 'x-hub-signature-256': signature }

			expect(handler.verify(config, body, headers)).toBe(true)
		})

		it('returns false for invalid signature', () => {
			const headers = { 'x-hub-signature-256': 'sha256=invalid' }
			expect(handler.verify(config, body, headers)).toBe(false)
		})

		it('returns false when signature header is missing', () => {
			expect(handler.verify(config, body, {})).toBe(false)
		})
	})

	describe('hmac-sha1 scheme', () => {
		const config: WebhookConfig = {
			signatureHeader: 'x-hub-signature',
			signatureScheme: 'hmac-sha1',
			secretEnv: 'WEBHOOK_SECRET',
		}

		it('returns true for valid sha1 signature', () => {
			const digest = createHmac('sha1', 'webhook-secret').update(body).digest('hex')
			const headers = { 'x-hub-signature': digest }

			expect(handler.verify(config, body, headers)).toBe(true)
		})

		it('returns false for invalid sha1 signature', () => {
			const headers = { 'x-hub-signature': 'invalid-digest' }
			expect(handler.verify(config, body, headers)).toBe(false)
		})
	})

	describe('timestamp scheme', () => {
		const config: WebhookConfig = {
			signatureHeader: 'x-signature',
			signatureScheme: 'timestamp',
			secretEnv: 'WEBHOOK_SECRET',
			timestampHeader: 'x-timestamp',
			timestampSignatureHeader: 'x-sig',
			timestampBodyTemplate: 'v0:{timestamp}:{body}',
			timestampSignaturePrefix: 'v0=',
		}

		it('returns true for valid timestamp signature', () => {
			const timestamp = String(Math.floor(Date.now() / 1000))
			const baseString = `v0:${timestamp}:${body}`
			const digest = createHmac('sha256', 'webhook-secret').update(baseString).digest('hex')
			const headers = { 'x-timestamp': timestamp, 'x-sig': `v0=${digest}` }

			expect(handler.verify(config, body, headers)).toBe(true)
		})

		it('throws when required timestamp config fields are missing', () => {
			const incompleteConfig: WebhookConfig = {
				signatureHeader: 'x-signature',
				signatureScheme: 'timestamp',
				secretEnv: 'WEBHOOK_SECRET',
			}

			expect(() => handler.verify(incompleteConfig, body, {})).toThrow(
				'timestampHeader, timestampSignatureHeader, and timestampBodyTemplate are required',
			)
		})
	})
})
