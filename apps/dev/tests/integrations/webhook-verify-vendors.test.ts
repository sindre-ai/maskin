import { describe, expect, it } from 'vitest'
import { VENDOR_RECIPES } from '../../src/lib/integrations/vendor-recipes'
import { WebhookHandler } from '../../src/lib/integrations/webhooks/handler'
import {
	CALCOM_VERIFY_CONFIG,
	FIREFLIES_VERIFY_CONFIG,
	buildCalcomDelivery,
	buildFirefliesDelivery,
} from './fixtures/signed-deliveries'

const handler = new WebhookHandler()
const secret = 'whsec_param_secret'

describe('WebhookHandler.verify with a secret passed as a param', () => {
	describe('Fireflies shape: hmac-sha256 with sha256= prefix', () => {
		it('passes for a correctly signed delivery', () => {
			const { body, headers } = buildFirefliesDelivery({ secret })
			expect(handler.verify(FIREFLIES_VERIFY_CONFIG, body, headers, { secret })).toBe(true)
		})

		it('fails when verified with a different secret', () => {
			const { body, headers } = buildFirefliesDelivery({ secret })
			const result = handler.verify(FIREFLIES_VERIFY_CONFIG, body, headers, { secret: 'other' })
			expect(result).toBe(false)
		})

		it('fails when the body was tampered with', () => {
			const { headers } = buildFirefliesDelivery({ secret })
			const tampered = buildFirefliesDelivery({ secret, meetingId: 'other-meeting' }).body
			expect(handler.verify(FIREFLIES_VERIFY_CONFIG, tampered, headers, { secret })).toBe(false)
		})

		it('fails when the sha256= prefix is missing', () => {
			const { body, headers } = buildFirefliesDelivery({ secret })
			const signed = headers['x-hub-signature'] ?? ''
			const unprefixed = { 'x-hub-signature': signed.slice('sha256='.length) }
			expect(handler.verify(FIREFLIES_VERIFY_CONFIG, body, unprefixed, { secret })).toBe(false)
		})
	})

	describe('Cal.com shape: hmac-sha256 raw hex, no prefix', () => {
		it('passes for a correctly signed delivery', () => {
			const { body, headers } = buildCalcomDelivery({ secret })
			expect(handler.verify(CALCOM_VERIFY_CONFIG, body, headers, { secret })).toBe(true)
		})

		it('fails when verified with a different secret', () => {
			const { body, headers } = buildCalcomDelivery({ secret })
			expect(handler.verify(CALCOM_VERIFY_CONFIG, body, headers, { secret: 'other' })).toBe(false)
		})

		it('fails when the body was tampered with', () => {
			const { headers } = buildCalcomDelivery({ secret })
			const tampered = buildCalcomDelivery({ secret, triggerEvent: 'BOOKING_CANCELLED' }).body
			expect(handler.verify(CALCOM_VERIFY_CONFIG, tampered, headers, { secret })).toBe(false)
		})

		it('fails when the digest carries a sha256= prefix', () => {
			const { body, headers } = buildCalcomDelivery({ secret })
			const prefixed = { 'x-cal-signature-256': `sha256=${headers['x-cal-signature-256']}` }
			expect(handler.verify(CALCOM_VERIFY_CONFIG, body, prefixed, { secret })).toBe(false)
		})

		it('fails when only the old wrong header name is present', () => {
			const { body, headers } = buildCalcomDelivery({ secret })
			const wrongHeader = { 'cal-signature-256': headers['x-cal-signature-256'] ?? '' }
			expect(handler.verify(CALCOM_VERIFY_CONFIG, body, wrongHeader, { secret })).toBe(false)
		})
	})
})

describe('VENDOR_RECIPES', () => {
	it('has exactly one entry, Fireflies, with the V2 webhook values', () => {
		expect(VENDOR_RECIPES.map((r) => r.slug)).toEqual(['fireflies'])
		const wh = VENDOR_RECIPES[0]?.webhookConfig
		expect(wh?.signatureScheme).toBe('hmac-sha256')
		expect(wh?.signatureHeader).toBe('X-Hub-Signature')
		expect(wh?.signaturePrefix).toBe('sha256=')
		expect(wh?.secretSource).toBe('credential')
		expect(wh?.eventMap).toEqual({
			externalIdPath: '$.meeting_id',
			entityType: { literal: 'fireflies.transcript' },
			action: { literal: 'ready' },
		})
	})

	it('points the fixture meeting id at the path the recipe reads', () => {
		const { body } = buildFirefliesDelivery({ secret, meetingId: 'abc123' })
		expect(JSON.parse(body)).toMatchObject({ event: 'meeting.transcribed', meeting_id: 'abc123' })
	})
})
