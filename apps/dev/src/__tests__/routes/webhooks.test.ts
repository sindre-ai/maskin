import { buildIntegration } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Mock the integrations registry
const mockGetProvider = vi.fn()
const mockListProviders = vi.fn()
vi.mock('../../lib/integrations/registry', () => ({
	getProvider: (...args: unknown[]) => mockGetProvider(...args),
	listProviders: (...args: unknown[]) => mockListProviders(...args),
}))

// Mock the webhook handler
const mockVerify = vi.fn()
vi.mock('../../lib/integrations/webhooks/handler', () => ({
	WebhookHandler: vi.fn().mockImplementation(() => ({
		verify: (...args: unknown[]) => mockVerify(...args),
	})),
}))

// Mock the event normalizer
const mockNormalizeEvent = vi.fn()
vi.mock('../../lib/integrations/events/normalizer', () => ({
	normalizeEvent: (...args: unknown[]) => mockNormalizeEvent(...args),
}))

const { webhookApp } = await import('../../routes/integrations')

function createWebhookTestApp() {
	return createTestApp(webhookApp, '/api/webhooks')
}

describe('Webhook Routes', () => {
	beforeEach(() => {
		mockGetProvider.mockReset()
		mockListProviders.mockReset()
		mockVerify.mockReset()
		mockNormalizeEvent.mockReset()
	})

	describe('POST /api/webhooks/:provider', () => {
		it('returns 400 for unknown provider', async () => {
			mockGetProvider.mockImplementation(() => {
				throw new Error('Unknown provider')
			})
			const { app } = createWebhookTestApp()

			const res = await app.request(
				jsonRequest('POST', '/api/webhooks/nonexistent', { event: 'test' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(body.error.message).toContain('Unknown provider')
		})

		it('returns 401 for invalid webhook signature', async () => {
			mockGetProvider.mockReturnValue({
				config: {
					name: 'github',
					webhook: {
						signatureHeader: 'x-hub-signature-256',
						signatureScheme: 'hmac-sha256',
						signaturePrefix: 'sha256=',
						secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
					},
				},
			})
			mockVerify.mockReturnValue(false)
			const { app } = createWebhookTestApp()

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { event: 'test' }))

			expect(res.status).toBe(401)
			const body = await res.json()
			expect(body.error.code).toBe('UNAUTHORIZED')
			expect(body.error.message).toContain('Invalid webhook signature')
		})

		it('returns 200 with skipped for unhandled event type', async () => {
			mockGetProvider.mockReturnValue({
				config: {
					name: 'github',
					webhook: {
						signatureHeader: 'x-hub-signature-256',
						signatureScheme: 'hmac-sha256',
						signaturePrefix: 'sha256=',
						secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
					},
				},
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue(null)
			const { app } = createWebhookTestApp()

			const res = await app.request(
				jsonRequest('POST', '/api/webhooks/github', { action: 'unhandled' }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBe(true)
		})

		it('returns 200 with skipped when no matching integration found', async () => {
			mockGetProvider.mockReturnValue({
				config: {
					name: 'github',
					webhook: {
						signatureHeader: 'x-hub-signature-256',
						signatureScheme: 'hmac-sha256',
						signaturePrefix: 'sha256=',
						secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
					},
				},
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue({
				action: 'push',
				entityType: 'repository',
				installationId: 'inst-123',
				data: {},
			})
			const { app } = createWebhookTestApp()

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBe(true)
		})

		it('returns 200 with skipped when integration has no system_actor_id', async () => {
			const integration = buildIntegration({ config: {} })
			mockGetProvider.mockReturnValue({
				config: {
					name: 'github',
					webhook: {
						signatureHeader: 'x-hub-signature-256',
						signatureScheme: 'hmac-sha256',
						signaturePrefix: 'sha256=',
						secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
					},
				},
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue({
				action: 'push',
				entityType: 'repository',
				installationId: integration.externalId,
				data: {},
			})
			const { app, mockResults } = createWebhookTestApp()
			mockResults.select = [integration]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBe(true)
		})

		it('returns 200 on successful webhook processing', async () => {
			const integration = buildIntegration({
				config: { system_actor_id: 'actor-123' },
			})
			mockGetProvider.mockReturnValue({
				config: {
					name: 'github',
					webhook: {
						signatureHeader: 'x-hub-signature-256',
						signatureScheme: 'hmac-sha256',
						signaturePrefix: 'sha256=',
						secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
					},
				},
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue({
				action: 'push',
				entityType: 'repository',
				installationId: integration.externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults } = createWebhookTestApp()
			mockResults.select = [integration]
			mockResults.insert = [{}] // event insert

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBeUndefined()
		})
	})
})
