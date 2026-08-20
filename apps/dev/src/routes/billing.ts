import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { CREDIT_TOPUP_MAX_USD, CREDIT_TOPUP_MIN_USD, workspaceSettingsSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import {
	DEFAULT_PERIOD_LENGTH_MS,
	PRO_HARD_CAP_DEFAULT_USD_CENTS,
	TEAM_HARD_CAP_DEFAULT_USD_CENTS,
	TRIAL_HARD_CAP_DEFAULT_USD_CENTS,
	parsePositiveIntEnv,
} from '../lib/billing-defaults'
import { createApiError } from '../lib/errors'
import { getWorkspacePlanUsdCentsUsage } from '../lib/llm-routing'
import {
	billingAfterCancel,
	cancelActivePaidSubscription,
	hasActivePaidPlan,
} from '../lib/llm-source-mutex'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	createCheckoutSession,
	createCreditCheckoutSession,
	getStripeClient,
	readStripeEnv,
} from '../lib/stripe'
import type { WorkspaceSettings } from '../lib/types'

/**
 * Fallback hard caps (USD cents) for paid plans when
 * `billing.hard_cap_usd_cents` hasn't been populated yet (delayed Stripe
 * webhook, partial state after a webhook failure). Read from env first via
 * the shared `parsePositiveIntEnv` (so `lib/stripe.ts`'s boot-time strict
 * parse and this defensive read agree on what a "valid" cap looks like),
 * then fall through to the documented literals. We parse env locally instead
 * of reusing `readStripeEnv` because that helper throws when Stripe is
 * unconfigured, and `/api/billing/usage` must keep serving usage to
 * workspaces regardless.
 */
function planHardCapFallback(plan: 'trial' | 'pro' | 'team' | 'byollm'): number | null {
	switch (plan) {
		case 'trial':
		case 'byollm':
			return TRIAL_HARD_CAP_DEFAULT_USD_CENTS
		case 'pro':
			return parsePositiveIntEnv('MASKIN_PRO_HARD_CAP_USD_CENTS') ?? PRO_HARD_CAP_DEFAULT_USD_CENTS
		case 'team':
			return (
				parsePositiveIntEnv('MASKIN_TEAM_HARD_CAP_USD_CENTS') ?? TEAM_HARD_CAP_DEFAULT_USD_CENTS
			)
	}
}

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const checkoutBodySchema = z.object({
	plan: z.enum(['pro', 'team']),
	success_url: z.string().url(),
	cancel_url: z.string().url(),
})

const checkoutResponseSchema = z.object({
	url: z.string().url(),
	session_id: z.string(),
})

const checkoutRoute = createRoute({
	method: 'post',
	path: '/checkout',
	tags: ['billing'],
	summary: 'Start a Stripe Checkout session for a Maskin subscription',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: checkoutBodySchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Checkout session created',
			content: { 'application/json': { schema: checkoutResponseSchema } },
		},
		400: {
			description: 'Bad request',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe misconfigured or upstream failure',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const usageResponseSchema = z.object({
	plan: z.enum(['trial', 'pro', 'team', 'byollm']),
	status: z.enum(['active', 'past_due', 'canceled', 'incomplete']),
	// Actual dollar cost incurred this period, in USD cents — not a token
	// count, since different agents can run different models with different
	// $/token ratios.
	usd_cents_used: z.number().int().nonnegative(),
	hard_cap_usd_cents: z.number().int().positive().nullable(),
	period_start: z.number().int().nonnegative().nullable(),
	period_resets_in_ms: z.number().int().nullable(),
	stripe_customer_id: z.string().nullable(),
	stripe_subscription_id: z.string().nullable(),
	// Prepaid usage-credits balance, in USD cents. Only meaningful for
	// pro/team — see `lib/credit-billing.ts`.
	credit_balance_cents: z.number().int().nonnegative(),
})

const usageRoute = createRoute({
	method: 'get',
	path: '/usage',
	tags: ['billing'],
	summary: 'Current billing plan + tokens used this period',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Current billing snapshot',
			content: { 'application/json': { schema: usageResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(usageRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [workspace] = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const parsed = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const billing = parsed.success ? parsed.data.billing : undefined

	// No billing row → workspace is on trial. Window starts whenever sessions
	// first ran; we use a 30d rolling window so the trial usage never grows
	// unbounded, and the row in Settings has a consistent "X / Y · resets in Zd".
	const plan = billing?.plan ?? 'trial'
	const status = billing?.status ?? 'active'
	const hardCapCents =
		billing?.hard_cap_usd_cents && billing.hard_cap_usd_cents > 0
			? billing.hard_cap_usd_cents
			: planHardCapFallback(plan)
	// `billing.period_start` is a Unix SECONDS value — the Stripe webhook
	// writes `subscription.current_period_start` straight through, and Stripe
	// timestamps are seconds (not ms). Coerce to a positive integer at read
	// time so a partial / legacy / malformed stored value never trips the
	// response schema (which requires `int().nonnegative()`).
	const rawPeriodStart = billing?.period_start
	const periodStartSec =
		typeof rawPeriodStart === 'number' && Number.isFinite(rawPeriodStart) && rawPeriodStart > 0
			? Math.floor(rawPeriodStart)
			: null
	const periodStartMs =
		periodStartSec !== null ? periodStartSec * 1000 : Date.now() - DEFAULT_PERIOD_LENGTH_MS
	const rawPeriodEnd = billing?.period_end
	const periodEndSec =
		typeof rawPeriodEnd === 'number' && Number.isFinite(rawPeriodEnd) && rawPeriodEnd > 0
			? Math.floor(rawPeriodEnd)
			: null
	const periodEndMs =
		periodEndSec !== null
			? periodEndSec * 1000
			: periodStartSec !== null
				? periodStartSec * 1000 + DEFAULT_PERIOD_LENGTH_MS
				: Date.now() + DEFAULT_PERIOD_LENGTH_MS

	const usdCentsUsed =
		plan !== 'byollm' ? await getWorkspacePlanUsdCentsUsage(db, workspaceId, periodStartMs) : 0

	const resetsIn = Math.max(0, periodEndMs - Date.now())

	const creditBalanceCents =
		typeof billing?.credit_balance_cents === 'number' && billing.credit_balance_cents > 0
			? Math.floor(billing.credit_balance_cents)
			: 0

	logger.info('Billing usage read', {
		workspaceId,
		plan,
		status,
		usdCentsUsed,
		hardCapCents,
		creditBalanceCents,
	})

	return c.json(
		{
			plan,
			status,
			usd_cents_used: usdCentsUsed,
			hard_cap_usd_cents: hardCapCents,
			period_start: periodStartSec,
			period_resets_in_ms: plan === 'byollm' ? null : resetsIn,
			stripe_customer_id: billing?.stripe_customer_id ?? null,
			stripe_subscription_id: billing?.stripe_subscription_id ?? null,
			credit_balance_cents: creditBalanceCents,
		},
		200,
	)
})

app.openapi(checkoutRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { plan, success_url, cancel_url } = c.req.valid('json')

	const [workspace] = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	// Existing billing.stripe_customer_id (if any) lets us reuse the same
	// Stripe Customer across plan changes — otherwise Stripe would create a
	// new customer for every checkout, and our customer→workspace map (kept
	// in settings.billing) would point at a stale id.
	const settingsParse = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const existingCustomerId = settingsParse.success
		? (settingsParse.data.billing?.stripe_customer_id ?? null)
		: null

	let stripeEnv: ReturnType<typeof readStripeEnv>
	try {
		stripeEnv = readStripeEnv()
	} catch (err) {
		logger.error('Stripe is not configured', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}

	const stripe = getStripeClient(stripeEnv)
	try {
		const session = await createCheckoutSession(
			stripe,
			{
				workspaceId,
				plan,
				successUrl: success_url,
				cancelUrl: cancel_url,
				existingCustomerId,
			},
			stripeEnv,
		)
		if (!session.url) {
			logger.error('Stripe checkout session missing url', { sessionId: session.id })
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe returned no checkout url'), 500)
		}
		return c.json({ url: session.url, session_id: session.id }, 200)
	} catch (err) {
		logger.error('Stripe checkout session creation failed', {
			workspaceId,
			plan,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create checkout session'), 500)
	}
})

const buyCreditsBodySchema = z.object({
	amount_usd_cents: z
		.number()
		.int()
		.min(CREDIT_TOPUP_MIN_USD * 100)
		.max(CREDIT_TOPUP_MAX_USD * 100),
	success_url: z.string().url(),
	cancel_url: z.string().url(),
})

const buyCreditsRoute = createRoute({
	method: 'post',
	path: '/credits/checkout',
	tags: ['billing'],
	summary: 'Start a Stripe Checkout session for a one-time usage-credits top-up',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: buyCreditsBodySchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Checkout session created',
			content: { 'application/json': { schema: checkoutResponseSchema } },
		},
		400: {
			description: 'Workspace is not eligible to buy usage credits',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe misconfigured or upstream failure',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(buyCreditsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { amount_usd_cents, success_url, cancel_url } = c.req.valid('json')

	const [workspace] = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settingsParse = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const billing = settingsParse.success ? settingsParse.data.billing : undefined

	// Same eligibility as spending a balance (`canUseCreditBalance`), minus
	// the balance>0 check since we're about to add to it: plan must be
	// pro/team, subscription active, and a Stripe customer already on file
	// (guaranteed once a paid checkout has completed).
	const eligible =
		(billing?.plan === 'pro' || billing?.plan === 'team') &&
		billing.status === 'active' &&
		Boolean(billing.stripe_customer_id)
	if (!eligible) {
		return c.json(
			createApiError('BAD_REQUEST', 'Workspace is not eligible to buy usage credits'),
			400,
		)
	}

	let stripeEnv: ReturnType<typeof readStripeEnv>
	try {
		stripeEnv = readStripeEnv()
	} catch (err) {
		logger.error('Stripe is not configured', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}

	const stripe = getStripeClient(stripeEnv)
	try {
		const session = await createCreditCheckoutSession(stripe, {
			workspaceId,
			amountUsdCents: amount_usd_cents,
			successUrl: success_url,
			cancelUrl: cancel_url,
			existingCustomerId: billing?.stripe_customer_id as string,
		})
		if (!session.url) {
			logger.error('Stripe credit top-up checkout session missing url', { sessionId: session.id })
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe returned no checkout url'), 500)
		}
		return c.json({ url: session.url, session_id: session.id }, 200)
	} catch (err) {
		logger.error('Stripe credit top-up checkout session creation failed', {
			workspaceId,
			amountUsdCents: amount_usd_cents,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create checkout session'), 500)
	}
})

const cancelRoute = createRoute({
	method: 'post',
	path: '/cancel',
	tags: ['billing'],
	summary: 'Downgrade to Free by cancelling the active Maskin subscription',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Subscription cancelled, plan set to Free',
			content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: { description: 'Stripe error', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(cancelRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [workspace] = await db
		.select({
			id: workspaces.id,
			settings: workspaces.settings,
			byollmAllowed: workspaces.byollmAllowed,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	const settings = (workspace.settings ?? {}) as WorkspaceSettings
	const billing = settings.billing

	if (hasActivePaidPlan({ billing })) {
		const subscriptionId = billing?.stripe_subscription_id
		if (!subscriptionId) {
			return c.json(createApiError('INTERNAL_ERROR', 'No active subscription id'), 500)
		}
		let stripeEnv: ReturnType<typeof readStripeEnv>
		try {
			stripeEnv = readStripeEnv()
		} catch {
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
		}
		try {
			await cancelActivePaidSubscription(getStripeClient(stripeEnv), subscriptionId)
		} catch (err) {
			logger.error('Stripe cancel failed', { workspaceId, error: String(err) })
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to cancel subscription'), 500)
		}
	}

	const downgraded = billingAfterCancel(billing, workspace.byollmAllowed)
	if (downgraded) {
		await db
			.update(workspaces)
			.set({ settings: { ...settings, billing: downgraded } })
			.where(eq(workspaces.id, workspaceId))
	}

	logger.info('Plan downgraded to Free', { workspaceId })
	return c.json({ ok: true as const }, 200)
})

export default app
