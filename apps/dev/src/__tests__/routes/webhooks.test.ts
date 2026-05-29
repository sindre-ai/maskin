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
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [integration]
			mockResults.insert = [{}] // event insert

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBeUndefined()
			expect(body.count).toBe(1)
			expect(body.workspaces).toBe(1)
			expect(calls.inserts).toHaveLength(1)
			expect((calls.inserts[0] as { workspaceId: string }[])[0]?.workspaceId).toBe(
				integration.workspaceId,
			)
		})

		// Regression: a single external install (e.g. one Slack team) can be connected
		// to multiple Maskin workspaces. The webhook router used to `.limit(1)` and
		// silently starve every workspace except whichever row Postgres returned first.
		it('fans out one delivery to every matching active integration', async () => {
			const externalId = 'shared-install-123'
			const int1 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws1' },
			})
			const int2 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws2' },
			})
			expect(int1.workspaceId).not.toBe(int2.workspaceId)

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
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [int1, int2]
			mockResults.insert = [{}]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.count).toBe(2)
			expect(body.workspaces).toBe(2)
			expect(calls.inserts).toHaveLength(2)
			const insertedWorkspaceIds = (calls.inserts as { workspaceId: string }[][]).map(
				(values) => values[0]?.workspaceId,
			)
			expect(insertedWorkspaceIds).toEqual(
				expect.arrayContaining([int1.workspaceId, int2.workspaceId]),
			)
		})

		// Regression: failure isolation across parallel inserts. If one workspace's
		// `db.insert(events)` throws, the other workspace's event must still land.
		// This proves the per-workspace try/catch in the fan-out loop actually works
		// — without it, a single bad row would take down the whole delivery.
		it('still records other workspaces when one events insert throws', async () => {
			const externalId = 'shared-install-789'
			const int1 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws1' },
			})
			const int2 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws2' },
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
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [int1, int2]
			// First insert (int1's event) succeeds; second insert (int2's event) throws.
			// Promise.all kicks off both synchronously in map() order, so the queue
			// position lines up with the eligible-integrations order.
			mockResults.insertErrorQueue = [undefined, new Error('db down for workspace 2')]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.count).toBe(1)
			expect(body.workspaces).toBe(2)
			expect(calls.inserts).toHaveLength(2)
			const insertedWorkspaceIds = (calls.inserts as { workspaceId: string }[][]).map(
				(values) => values[0]?.workspaceId,
			)
			// Both inserts were attempted (the failure didn't short-circuit the other),
			// and the surviving workspace got its event recorded.
			expect(insertedWorkspaceIds).toEqual(
				expect.arrayContaining([int1.workspaceId, int2.workspaceId]),
			)
		})

		it('still records other workspaces when one integration is missing system_actor_id', async () => {
			const externalId = 'shared-install-456'
			const bad = buildIntegration({ externalId, config: {} })
			const good = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-good' },
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
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [bad, good]
			mockResults.insert = [{}]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.count).toBe(1)
			expect(body.workspaces).toBe(1)
			expect(calls.inserts).toHaveLength(1)
			expect((calls.inserts[0] as { workspaceId: string }[])[0]?.workspaceId).toBe(good.workspaceId)
		})

		// Per-workspace dedup: a single delivery_id can be retried independently for
		// each workspace. If one workspace already claimed the delivery (returning []
		// from onConflictDoNothing), the other workspace's claim still succeeds and
		// its event still lands. The whole-delivery short-circuit ('duplicate') only
		// fires when every workspace's claim conflicts.
		it('skips workspaces that already claimed the delivery but processes new ones', async () => {
			const externalId = 'shared-install-dedup'
			const int1 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws1' },
			})
			const int2 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws2' },
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
				extractDeliveryId: () => 'delivery-abc',
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue({
				action: 'push',
				entityType: 'repository',
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [int1, int2]
			// Insert order under Promise.all + map: claim1, claim2, then event-inserts
			// for any workspace that successfully claimed. int1 claims, int2 conflicts,
			// so only event1 is inserted afterwards.
			mockResults.insertQueue = [
				[{ id: 'claim-1' }], // int1 claim → succeeds
				[], // int2 claim → conflict (already processed for that workspace)
				[{}], // int1 event insert
			]
			// Gated processed_at UPDATE inside the events+update txn must report 1
			// matched row, otherwise the helper treats the claim as reconciler-released
			// and aborts.
			mockResults.update = [{ id: 'claim-1' }]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBeUndefined()
			expect(body.count).toBe(1)
			expect(body.workspaces).toBe(2)
			// 3 inserts total: 2 claims + 1 event (the duplicate workspace skipped its event).
			expect(calls.inserts).toHaveLength(3)
			const eventInsert = calls.inserts[2] as { workspaceId: string }[]
			expect(eventInsert[0]?.workspaceId).toBe(int1.workspaceId)
		})

		// Regression: simulates a post-claim event-insert failure (e.g. the PG NOTIFY
		// 8KB rejection in .claude/rules/known-pitfalls.md). The claim is taken
		// up front (so duplicate retries skip expensive fan-out), and a thrown event
		// insert triggers a compensating delete on the claim row — otherwise the
		// dedup row would survive and starve provider retries for that workspace
		// forever.
		it('releases the dedup claim when the event insert throws after a successful claim', async () => {
			const externalId = 'shared-install-rollback'
			const int1 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws1' },
			})
			const int2 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws2' },
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
				extractDeliveryId: () => 'delivery-rollback',
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue({
				action: 'push',
				entityType: 'repository',
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [int1, int2]
			// Both claims succeed (insert calls 1 & 2). int1's event insert (call 3)
			// succeeds; int2's event insert (call 4) throws — the route then issues a
			// compensating delete on int2's claim row so retries can re-attempt.
			mockResults.insertQueue = [[{ id: 'claim-1' }], [{ id: 'claim-2' }]]
			mockResults.insertErrorQueue = [
				undefined,
				undefined,
				undefined,
				new Error('events trigger rejected payload'),
			]
			// int1 commits cleanly so its gated processed_at UPDATE must report 1
			// matched row. int2's event insert throws before it would UPDATE, so a
			// static result suffices for both paths.
			mockResults.update = [{ id: 'claim-1' }]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			// int1 lands its event; int2's event insert throws and its claim is released.
			expect(body.count).toBe(1)
			expect(body.workspaces).toBe(2)
			// 4 inserts attempted: 2 claims + 2 event inserts (int2's threw).
			expect(calls.inserts).toHaveLength(4)
		})

		// Regression: webhookFanOut can do expensive network work (Gmail's
		// users.history.list, Slack file attachment downloads). It MUST run only
		// after the per-workspace claim has succeeded — otherwise every retry of
		// a duplicate delivery would re-do the work until the claim caught it.
		it('does not run webhookFanOut for workspaces whose claim conflicts', async () => {
			const externalId = 'shared-install-fanout-dedup'
			const int1 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws1' },
			})
			const int2 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws2' },
			})

			const normalized = {
				action: 'push',
				entityType: 'repository',
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			}
			const fanOut = vi.fn(async () => [normalized])

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
				extractDeliveryId: () => 'delivery-fanout-dedup',
				webhookFanOut: fanOut,
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue(normalized)
			const { app, mockResults } = createWebhookTestApp()
			mockResults.select = [int1, int2]
			// int1 claim succeeds, int2 claim conflicts. int1 then runs fan-out + event;
			// int2 must skip fan-out entirely.
			mockResults.insertQueue = [
				[{ id: 'claim-1' }], // int1 claim
				[], // int2 claim → conflict
				[{}], // int1 event insert
			]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			expect(fanOut).toHaveBeenCalledTimes(1)
			expect(fanOut.mock.calls[0]?.[0]?.workspaceId).toBe(int1.workspaceId)
		})

		it('returns skipped=duplicate only when every workspace claim conflicts', async () => {
			const externalId = 'shared-install-all-dup'
			const int1 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws1' },
			})
			const int2 = buildIntegration({
				externalId,
				config: { system_actor_id: 'actor-ws2' },
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
				extractDeliveryId: () => 'delivery-xyz',
			})
			mockVerify.mockReturnValue(true)
			mockNormalizeEvent.mockReturnValue({
				action: 'push',
				entityType: 'repository',
				installationId: externalId,
				data: { ref: 'refs/heads/main' },
			})
			const { app, mockResults, calls } = createWebhookTestApp()
			mockResults.select = [int1, int2]
			mockResults.insertQueue = [
				[], // int1 claim → conflict
				[], // int2 claim → conflict
			]

			const res = await app.request(jsonRequest('POST', '/api/webhooks/github', { action: 'push' }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.skipped).toBe('duplicate')
			// Both claims attempted, but no event inserts happened.
			expect(calls.inserts).toHaveLength(2)
		})
	})
})
