import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cancelMock, getStripeClientMock } = vi.hoisted(() => {
	const cancel = vi.fn()
	const getClient = vi.fn(() => ({ subscriptions: { cancel } }))
	return { cancelMock: cancel, getStripeClientMock: getClient }
})

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: getStripeClientMock,
		verifyStripeWebhook: vi.fn(),
	}
})
vi.mock('../../lib/claude-oauth', () => ({
	encryptOAuthTokens: vi.fn().mockReturnValue({
		encryptedAccessToken: 'enc-access',
		encryptedRefreshToken: 'enc-refresh',
		expiresAt: 9_999_999_999,
		subscriptionType: 'pro',
	}),
	getValidOAuthToken: vi.fn(),
}))

import type Stripe from 'stripe'
import { verifyStripeWebhook } from '../../lib/stripe'
import { buildWorkspaceMember } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { default: claudeOauthRoutes } = await import('../../routes/claude-oauth')
const { default: stripeWebhookRoutes } = await import('../../routes/stripe-webhook')

const STRIPE_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_STARTER: 'price_starter',
	STRIPE_PRICE_PRO: 'price_pro',
	MASKIN_STARTER_HARD_CAP_TOKENS: '32000000',
	MASKIN_PRO_HARD_CAP_TOKENS: '96000000',
}
const setStripeEnv = () => {
	for (const [k, v] of Object.entries(STRIPE_ENV)) process.env[k] = v
}
const clearStripeEnv = () => {
	for (const k of Object.keys(STRIPE_ENV)) delete process.env[k]
}

const wsId = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
	cancelMock.mockReset()
	cancelMock.mockResolvedValue({})
	getStripeClientMock.mockClear()
	vi.mocked(verifyStripeWebhook).mockReset()
	clearStripeEnv()
	setStripeEnv()
})

type WorkspaceUpdate = { settings: Record<string, unknown> }
function findWorkspaceUpdate(updates: unknown[]): WorkspaceUpdate {
	const match = updates.find(
		(u): u is WorkspaceUpdate =>
			!!u && typeof u === 'object' && 'settings' in (u as Record<string, unknown>),
	)
	if (!match) throw new Error('expected a workspace settings update; got none')
	return match
}

describe('BYOLLM ↔ paid plan mutex — PATCH /api/workspaces/:id', () => {
	it('cancels live Stripe sub and writes billing.plan=byollm when setting llm_keys.anthropic', async () => {
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							stripe_subscription_id: 'sub_live',
							stripe_customer_id: 'cus_live',
							hard_cap_tokens: 96_000_000,
						},
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: 'sk-ant-byo' } },
			}),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).toHaveBeenCalledWith('sub_live')
		// Atomicity: the cancel + downgrade + BYO add must land as ONE row write.
		// A future refactor that splits this into separate updates fails here.
		expect(calls.updates).toHaveLength(1)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings).toMatchObject({
			llm_keys: { anthropic: 'sk-ant-byo' },
			billing: {
				plan: 'byollm',
				status: 'canceled',
				stripe_subscription_id: null,
				stripe_customer_id: 'cus_live',
			},
		})
	})

	it('cancels live Stripe sub when enabling custom_llm with an api_key', async () => {
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'starter',
							status: 'active',
							stripe_subscription_id: 'sub_starter',
						},
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: {
					custom_llm: {
						enabled: true,
						api_key: 'sk-or-byo',
						base_url: 'https://openrouter.ai',
						model: 'anthropic/claude',
					},
				},
			}),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).toHaveBeenCalledWith('sub_starter')
		expect(calls.updates).toHaveLength(1)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings).toMatchObject({
			custom_llm: { enabled: true, api_key: 'sk-or-byo' },
			billing: { plan: 'byollm', status: 'canceled', stripe_subscription_id: null },
		})
	})

	it('does NOT call Stripe when llm_keys.anthropic is being deleted (null)', async () => {
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							stripe_subscription_id: 'sub_live',
						},
						llm_keys: { anthropic: 'sk-ant-old' },
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: null } },
			}),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).not.toHaveBeenCalled()
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			plan: 'pro',
			status: 'active',
			stripe_subscription_id: 'sub_live',
		})
	})

	it('skips Stripe call when there is no live subscription to cancel', async () => {
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: { billing: { plan: 'byollm', status: 'canceled' } },
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: 'sk-ant-new' } },
			}),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(1)
	})

	it('does NOT cancel Stripe when the paid plan is in the SCA `incomplete` window', async () => {
		// Reviewer-flagged asymmetry fix: a newly-created sub in `incomplete`
		// (SCA pending) used to read as active via the broad ACTIVE_PAID_STATUSES
		// set, so a BYO write would cancel a sub the customer may yet authorize.
		// With `hasActivePaidPlan` narrowed to `active`, the BYO write coexists
		// with the pending paid row — the webhook reconciles on SCA confirm.
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'incomplete',
							stripe_subscription_id: 'sub_sca_pending',
						},
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: 'sk-ant-byo' } },
			}),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(1)
		const update = findWorkspaceUpdate(calls.updates)
		// The BYO key lands; billing stays exactly as the webhook left it so
		// SCA confirmation can still flip it to active and clear BYO then.
		expect(update.settings.llm_keys).toMatchObject({ anthropic: 'sk-ant-byo' })
		expect(update.settings.billing).toMatchObject({
			plan: 'pro',
			status: 'incomplete',
			stripe_subscription_id: 'sub_sca_pending',
		})
	})

	it('rejects an empty / whitespace anthropic key at the schema layer with 400', async () => {
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [[{ id: wsId, settings: {} }]]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: '   ' } },
			}),
		)

		expect(res.status).toBe(400)
		expect(cancelMock).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(0)
	})

	it('returns 500 and does NOT apply local change if Stripe cancel throws a non-missing error', async () => {
		cancelMock.mockRejectedValue(Object.assign(new Error('rate_limited'), { code: 'rate_limit' }))
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							stripe_subscription_id: 'sub_live',
						},
					},
				},
			],
		]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: 'sk-ant-byo' } },
			}),
		)

		expect(res.status).toBe(500)
		// Critically: the local state must not have been written when Stripe rejected.
		expect(calls.updates).toHaveLength(0)
	})

	it('proceeds when Stripe replies resource_missing — treats the sub as already gone', async () => {
		cancelMock.mockRejectedValue(
			Object.assign(new Error('No such subscription'), { code: 'resource_missing' }),
		)
		const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							stripe_subscription_id: 'sub_phantom',
						},
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${wsId}`, {
				settings: { llm_keys: { anthropic: 'sk-ant-byo' } },
			}),
		)

		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.billing).toMatchObject({
			plan: 'byollm',
			status: 'canceled',
			stripe_subscription_id: null,
		})
	})
})

describe('BYOLLM ↔ paid plan mutex — POST /api/claude-oauth/import', () => {
	const importBody = {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresAt: 9_999_999_999,
	}
	const headers = { 'x-workspace-id': wsId }

	it('cancels live Stripe sub when a workspace imports Claude OAuth tokens', async () => {
		const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
		mockResults.selectQueue = [
			[buildWorkspaceMember()],
			[
				{
					id: wsId,
					settings: {
						billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_live' },
					},
				},
			],
		]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody, headers),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).toHaveBeenCalledWith('sub_live')
		expect(calls.updates).toHaveLength(1)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.claude_oauth).toBeDefined()
		expect(update.settings.billing).toMatchObject({
			plan: 'byollm',
			status: 'canceled',
			stripe_subscription_id: null,
		})
	})

	it('returns 500 and does NOT persist tokens when Stripe cancel fails', async () => {
		cancelMock.mockRejectedValue(Object.assign(new Error('rate_limited'), { code: 'rate_limit' }))
		const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
		mockResults.selectQueue = [
			[buildWorkspaceMember()],
			[
				{
					id: wsId,
					settings: {
						billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_live' },
					},
				},
			],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody, headers),
		)

		expect(res.status).toBe(500)
		expect(calls.updates).toHaveLength(0)
	})

	it('skips Stripe entirely when the workspace has no active paid plan', async () => {
		const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
		mockResults.selectQueue = [[buildWorkspaceMember()], [{ id: wsId, settings: {} }]]
		mockResults.update = [{ id: wsId, settings: {} }]

		const res = await app.request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody, headers),
		)

		expect(res.status).toBe(200)
		expect(cancelMock).not.toHaveBeenCalled()
		expect(calls.updates).toHaveLength(1)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings.claude_oauth).toBeDefined()
		expect(update.settings.billing).toBeUndefined()
	})
})

describe('BYOLLM ↔ paid plan mutex — Stripe webhook clears BYO slots on active', () => {
	it('drops claude_oauth + custom_llm + llm_keys.anthropic on customer.subscription.updated → active', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		mockResults.insertQueue = [[{ id: 'claim-mutex-1' }]]
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						llm_keys: { anthropic: 'sk-ant', openai: 'sk-open' },
						custom_llm: { enabled: true, api_key: 'sk-or' },
						claude_oauth: { encryptedAccessToken: 'enc' },
						display_names: { insight: 'Signal' },
					},
				},
			],
		]
		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_active_1',
			type: 'customer.subscription.updated',
			data: {
				object: {
					id: 'sub_active',
					customer: 'cus_a',
					status: 'active',
					current_period_start: 1_700_000_000,
					metadata: { workspace_id: wsId },
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			},
		} as unknown as Stripe.Event)

		const res = await app.request(
			new Request('http://localhost/api/webhooks/stripe', {
				method: 'POST',
				headers: { 'stripe-signature': 't=1,v1=abc' },
				body: '{}',
			}),
		)

		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		expect(update.settings).toMatchObject({
			display_names: { insight: 'Signal' },
			llm_keys: { openai: 'sk-open' },
			billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_active' },
		})
		expect(update.settings.custom_llm).toBeUndefined()
		expect(update.settings.claude_oauth).toBeUndefined()
		expect((update.settings.llm_keys as Record<string, unknown>).anthropic).toBeUndefined()
	})

	it('leaves BYO slots intact on customer.subscription.deleted (non-active terminal)', async () => {
		const { app, mockResults, calls } = createTestApp(stripeWebhookRoutes, '/api/webhooks/stripe')
		mockResults.insertQueue = [[{ id: 'claim-mutex-2' }]]
		mockResults.selectQueue = [
			[
				{
					id: wsId,
					settings: {
						llm_keys: { anthropic: 'sk-ant' },
						custom_llm: { enabled: true, api_key: 'sk-or' },
						claude_oauth: { encryptedAccessToken: 'enc' },
						billing: { plan: 'pro', status: 'active', stripe_subscription_id: 'sub_x' },
					},
				},
			],
		]
		vi.mocked(verifyStripeWebhook).mockReturnValue({
			id: 'evt_deleted_1',
			type: 'customer.subscription.deleted',
			data: {
				object: {
					id: 'sub_x',
					customer: 'cus_x',
					status: 'canceled',
					canceled_at: 1_700_001_000,
					metadata: { workspace_id: wsId },
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			},
		} as unknown as Stripe.Event)

		const res = await app.request(
			new Request('http://localhost/api/webhooks/stripe', {
				method: 'POST',
				headers: { 'stripe-signature': 't=1,v1=abc' },
				body: '{}',
			}),
		)

		expect(res.status).toBe(200)
		const update = findWorkspaceUpdate(calls.updates)
		// Critical: the workspace is falling back to BYO — preserve the slots so
		// the user keeps working without having to re-paste their key.
		expect(update.settings).toMatchObject({
			llm_keys: { anthropic: 'sk-ant' },
			custom_llm: { enabled: true, api_key: 'sk-or' },
			claude_oauth: { encryptedAccessToken: 'enc' },
			billing: { plan: 'byollm', status: 'canceled', stripe_subscription_id: null },
		})
	})
})
