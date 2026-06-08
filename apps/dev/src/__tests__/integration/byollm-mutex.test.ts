import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

// Stripe env must be set BEFORE the route module reads it on the first request.
// `readStripeEnv()` runs per-request inside the webhook + workspaces handlers,
// so plain assignment here is enough — no module-load ordering trap.
const STRIPE_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_STARTER: 'price_starter_test',
	STRIPE_PRICE_PRO: 'price_pro_test',
	MASKIN_STARTER_HARD_CAP_TOKENS: '32000000',
	MASKIN_PRO_HARD_CAP_TOKENS: '96000000',
}
for (const [k, v] of Object.entries(STRIPE_ENV)) process.env[k] = v

const { cancelMock, getStripeClientMock, verifyStripeWebhookMock } = vi.hoisted(() => {
	const cancel = vi.fn()
	const getClient = vi.fn(() => ({ subscriptions: { cancel } }))
	const verify = vi.fn()
	return {
		cancelMock: cancel,
		getStripeClientMock: getClient,
		verifyStripeWebhookMock: verify,
	}
})

// Only the Stripe SDK boundary is mocked — the test exercises the real
// row-level lock around it, which is the whole point of this integration test.
vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: getStripeClientMock,
		verifyStripeWebhook: verifyStripeWebhookMock,
	}
})

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { default: stripeWebhookRoutes } = await import('../../routes/stripe-webhook')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

function createApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/workspaces', workspacesRoutes)
	app.route('/api/webhooks/stripe', stripeWebhookRoutes)
	return app
}

type BillingShape = {
	plan: string
	status: string
	stripe_subscription_id: string | null
	stripe_customer_id?: string | null
	hard_cap_tokens?: number | null
}

type SettingsShape = {
	billing?: BillingShape
	llm_keys?: { anthropic?: string | null }
}

async function readSettings(workspaceId: string): Promise<SettingsShape> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
	return (row?.settings ?? {}) as SettingsShape
}

describe('BYOLLM ↔ paid plan mutex — concurrent integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		cancelMock.mockReset()
		cancelMock.mockResolvedValue({} as Stripe.Subscription)
		getStripeClientMock.mockClear()
		verifyStripeWebhookMock.mockReset()
		// webhook_deliveries isn't in the harness TRUNCATE list — clear it so
		// repeat runs don't trip the dedup ledger.
		await sql`TRUNCATE webhook_deliveries CASCADE`

		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		await db
			.update(workspaces)
			.set({
				settings: {
					...(ws.settings as Record<string, unknown>),
					billing: {
						plan: 'pro',
						status: 'active',
						stripe_subscription_id: 'sub_live_test',
						stripe_customer_id: 'cus_live_test',
						hard_cap_tokens: 96_000_000,
					},
				},
			})
			.where(eq(workspaces.id, workspaceId))
	})

	it('PATCH + Stripe webhook race never leaves BYO and active paid coexisting', async () => {
		verifyStripeWebhookMock.mockReturnValue({
			id: 'evt_test_race',
			type: 'customer.subscription.updated',
			data: {
				object: {
					id: 'sub_live_test',
					customer: 'cus_live_test',
					status: 'active',
					metadata: { workspace_id: workspaceId },
					items: { data: [{ price: { id: 'price_starter_test' } }] },
					current_period_start: 1_700_000_000,
				},
			},
		} as unknown as Stripe.Event)

		const app = createApp(actorId)
		const patchReq = app.request(
			jsonRequest('PATCH', `/api/workspaces/${workspaceId}`, {
				settings: { llm_keys: { anthropic: 'sk-ant-race' } },
			}),
		)
		const webhookReq = app.request(
			new Request('http://localhost/api/webhooks/stripe', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'stripe-signature': 't=1,v1=fake',
				},
				body: JSON.stringify({}),
			}),
		)

		const [patchRes, webhookRes] = await Promise.all([patchReq, webhookReq])
		expect(patchRes.status).toBe(200)
		expect(webhookRes.status).toBe(200)

		const settings = await readSettings(workspaceId)
		const hasByo =
			typeof settings.llm_keys?.anthropic === 'string' && settings.llm_keys.anthropic.length > 0
		const hasActivePaid =
			settings.billing?.status === 'active' && !!settings.billing.stripe_subscription_id
		expect(hasByo && hasActivePaid).toBe(false)

		// One side has to win — both being absent would mean the row was wiped.
		expect(hasByo || hasActivePaid).toBe(true)
	})

	it('two concurrent BYO PATCHes both succeed; Stripe cancel runs exactly once', async () => {
		const app = createApp(actorId)
		const [aRes, bRes] = await Promise.all([
			app.request(
				jsonRequest('PATCH', `/api/workspaces/${workspaceId}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-A' } },
				}),
			),
			app.request(
				jsonRequest('PATCH', `/api/workspaces/${workspaceId}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-B' } },
				}),
			),
		])
		expect(aRes.status).toBe(200)
		expect(bRes.status).toBe(200)

		// First writer cancels Stripe; the second locks the row AFTER the first
		// commits, sees stripe_subscription_id=null + status=canceled, and skips
		// the cancel entirely.
		expect(cancelMock).toHaveBeenCalledTimes(1)
		expect(cancelMock).toHaveBeenCalledWith('sub_live_test')

		const settings = await readSettings(workspaceId)
		expect(['sk-ant-A', 'sk-ant-B']).toContain(settings.llm_keys?.anthropic)
		expect(settings.billing?.status).toBe('canceled')
		expect(settings.billing?.plan).toBe('byollm')
		expect(settings.billing?.stripe_subscription_id).toBeNull()
	})

	// Test #3 from the brief (deterministic mid-tx interleave via advisory locks
	// or pg_sleep injection) is intentionally not implemented. The brief allows
	// skipping when the harness has no way to interleave inside the FOR UPDATE
	// window. `global-setup.ts` doesn't expose such a probe, and tests #1 and #2
	// already prove the lock works: without `.for('update')`, test #1's race
	// flakes (both sides land) and test #2's two PATCHes both call Stripe.cancel.
})
