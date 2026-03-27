import { describe, expect, it } from 'vitest'
import { normalizeEvent } from '../../../lib/integrations/events/normalizer'
import type { ResolvedProvider, WebhookConfig } from '../../../lib/integrations/types'

function makeProvider(overrides?: Partial<ResolvedProvider>): ResolvedProvider {
	return {
		config: {
			name: 'test-provider',
			displayName: 'Test Provider',
			auth: { type: 'oauth2_custom' },
			webhook: {
				signatureHeader: 'x-signature',
				signatureScheme: 'hmac-sha256',
				secretEnv: 'SECRET',
				eventTypeHeader: 'x-event-type',
			},
			events: {
				definitions: [],
				mapping: {
					'issue.opened': { entityType: 'test.issue', action: 'opened' },
					issue: { entityType: 'test.issue', action: 'generic' },
					push: { entityType: 'test.push', action: 'pushed' },
				},
			},
		},
		...overrides,
	}
}

describe('normalizeEvent', () => {
	describe('custom normalizer', () => {
		it('uses custom normalizer when provided', () => {
			const customNormalizer = () => ({
				entityType: 'custom.type',
				action: 'custom_action',
				installationId: 'custom-123',
				data: { custom: true },
			})
			const provider = makeProvider({ customNormalizer })

			const result = normalizeEvent(provider, { test: true }, { 'x-event-type': 'anything' })
			expect(result).toEqual({
				entityType: 'custom.type',
				action: 'custom_action',
				installationId: 'custom-123',
				data: { custom: true },
			})
		})

		it('custom normalizer can return null', () => {
			const customNormalizer = () => null
			const provider = makeProvider({ customNormalizer })

			const result = normalizeEvent(provider, {}, {})
			expect(result).toBeNull()
		})
	})

	describe('declarative mapping', () => {
		it('matches exact key (eventType.action)', () => {
			const provider = makeProvider()
			const payload = {
				action: 'opened',
				installation: { id: 123 },
			}
			const headers = { 'x-event-type': 'issue' }

			const result = normalizeEvent(provider, payload, headers)
			expect(result).toEqual({
				entityType: 'test.issue',
				action: 'opened',
				installationId: '123',
				data: payload,
			})
		})

		it('falls back to eventType-only key when no exact match', () => {
			const provider = makeProvider()
			const payload = {
				action: 'closed', // no 'issue.closed' key in mapping
				installation: { id: 456 },
			}
			const headers = { 'x-event-type': 'issue' }

			const result = normalizeEvent(provider, payload, headers)
			expect(result).toEqual({
				entityType: 'test.issue',
				action: 'generic',
				installationId: '456',
				data: payload,
			})
		})

		it('matches event without action', () => {
			const provider = makeProvider()
			const payload = { installation: { id: 789 } }
			const headers = { 'x-event-type': 'push' }

			const result = normalizeEvent(provider, payload, headers)
			expect(result).toEqual({
				entityType: 'test.push',
				action: 'pushed',
				installationId: '789',
				data: payload,
			})
		})

		it('returns null for unhandled event type', () => {
			const provider = makeProvider()
			const payload = { installation: { id: 123 } }
			const headers = { 'x-event-type': 'unknown_event' }

			expect(normalizeEvent(provider, payload, headers)).toBeNull()
		})

		it('returns null when no installation ID found', () => {
			const provider = makeProvider()
			const payload = { action: 'opened' }
			const headers = { 'x-event-type': 'issue' }

			expect(normalizeEvent(provider, payload, headers)).toBeNull()
		})

		it('extracts installation ID from account_id', () => {
			const provider = makeProvider()
			const payload = { account_id: 'acct-42' }
			const headers = { 'x-event-type': 'push' }

			const result = normalizeEvent(provider, payload, headers)
			expect(result?.installationId).toBe('acct-42')
		})

		it('extracts installation ID from team_id', () => {
			const provider = makeProvider()
			const payload = { team_id: 'team-99' }
			const headers = { 'x-event-type': 'push' }

			const result = normalizeEvent(provider, payload, headers)
			expect(result?.installationId).toBe('team-99')
		})

		it('returns null when no mapping defined', () => {
			const provider = makeProvider({
				config: {
					...makeProvider().config,
					events: { definitions: [] },
				},
			})
			const payload = { installation: { id: 1 } }
			const headers = { 'x-event-type': 'issue' }

			expect(normalizeEvent(provider, payload, headers)).toBeNull()
		})

		it('returns null for non-object payload', () => {
			const provider = makeProvider()
			expect(normalizeEvent(provider, 'string', {})).toBeNull()
			expect(normalizeEvent(provider, null, {})).toBeNull()
			expect(normalizeEvent(provider, [1, 2], {})).toBeNull()
		})

		it('returns null when webhook config has custom type', () => {
			const provider = makeProvider({
				config: {
					...makeProvider().config,
					webhook: { type: 'custom' },
				},
			})
			const payload = { installation: { id: 1 } }

			expect(normalizeEvent(provider, payload, {})).toBeNull()
		})
	})
})
