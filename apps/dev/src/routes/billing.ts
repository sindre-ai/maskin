import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessions, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	createBillingPortalSession,
	createCheckoutSession,
	getStripeClient,
	readStripeEnv,
} from '../lib/stripe'

/**
 * Trial bucket sizing when no Stripe-driven `period_start` is set yet.
 * Mirrors `MASKIN_TRIAL_HARD_CAP_TOKENS` consumed by the hard-cap enforcement
 * path so the row + the enforcement read the same number.
 */
const DEFAULT_TRIAL_HARD_CAP_TOKENS = 100_000
const TRIAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/**
 * LLM-route tag the paid-plan + trial sessions write on `sessions.config.llm_route`.
 * Lives as a literal here so this task doesn't import from the hard-cap branch;
 * when the bet branch rebases everything together the constant in
 * `lib/llm-routing.ts` is the canonical source.
 */
const LLM_ROUTE_MASKIN_PLAN = 'maskin_plan'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// Stripe redirects the browser to `success_url`/`cancel_url` after the
// Checkout flow completes or is abandoned. Same threat model as the portal
// `return_url`: a session-compromised caller could drive the user through
// Stripe out to an attacker domain. Gate both fields with the same
// `urlMatchesAppOrigin` refine used below (hoisted function declaration).
const checkoutBodySchema = z.object({
	plan: z.enum(['starter', 'pro']),
	success_url: z
		.string()
		.url()
		.refine((u) => urlMatchesAppOrigin(u), {
			message: 'success_url origin must match FRONTEND_URL',
		}),
	cancel_url: z
		.string()
		.url()
		.refine((u) => urlMatchesAppOrigin(u), {
			message: 'cancel_url origin must match FRONTEND_URL',
		}),
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
	plan: z.enum(['trial', 'starter', 'pro', 'byollm']),
	status: z.enum(['active', 'past_due', 'canceled', 'incomplete']),
	tokens_used: z.number().int().nonnegative(),
	hard_cap_tokens: z.number().int().positive().nullable(),
	period_start: z.number().int().nonnegative().nullable(),
	period_resets_in_ms: z.number().int().nullable(),
	stripe_customer_id: z.string().nullable(),
	stripe_subscription_id: z.string().nullable(),
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
	const hardCap =
		billing?.hard_cap_tokens && billing.hard_cap_tokens > 0
			? billing.hard_cap_tokens
			: plan === 'trial' || plan === 'byollm'
				? DEFAULT_TRIAL_HARD_CAP_TOKENS
				: null
	// `billing.period_start` is a Unix SECONDS value — the Stripe webhook
	// writes `subscription.current_period_start` straight through, and Stripe
	// timestamps are seconds (not ms). Multiply by 1000 here so `new Date()`,
	// `Date.now()`, and the resets-in arithmetic all operate in ms.
	const periodStartMs = billing?.period_start
		? billing.period_start * 1000
		: Date.now() - TRIAL_WINDOW_MS
	const periodEndMs = billing?.period_start
		? // Stripe periods are 28-31d; we don't store period_end on this branch,
			// so we approximate as "30d from period_start" for the resets-in hint.
			billing.period_start * 1000 + TRIAL_WINDOW_MS
		: Date.now() + TRIAL_WINDOW_MS

	let tokensUsed = 0
	if (plan !== 'byollm') {
		const since = new Date(periodStartMs)
		const rows = await db
			.select({
				inputTokens: sessions.inputTokens,
				outputTokens: sessions.outputTokens,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					gte(sessions.createdAt, since),
					sql`${sessions.config}->>'llm_route' = ${LLM_ROUTE_MASKIN_PLAN}`,
				),
			)
		for (const row of rows) {
			tokensUsed += row.inputTokens ?? 0
			tokensUsed += row.outputTokens ?? 0
		}
	}

	const resetsIn = Math.max(0, periodEndMs - Date.now())

	logger.info('Billing usage read', {
		workspaceId,
		plan,
		status,
		tokensUsed,
		hardCap,
	})

	return c.json(
		{
			plan,
			status,
			tokens_used: tokensUsed,
			hard_cap_tokens: hardCap,
			period_start: billing?.period_start ?? null,
			period_resets_in_ms: plan === 'byollm' ? null : resetsIn,
			stripe_customer_id: billing?.stripe_customer_id ?? null,
			stripe_subscription_id: billing?.stripe_subscription_id ?? null,
		},
		200,
	)
})

// Stripe redirects the browser to `return_url` when the user closes the
// Billing Portal — whatever we send is where the user lands. Constrain the
// origin to the configured app so a session-compromised caller can't drive
// the user out to an attacker domain on the way back from Stripe. Origin is
// resolved lazily so tests using `vi.stubEnv('FRONTEND_URL', ...)` and the
// dev fallback both work without route-boot ordering tricks.
const portalBodySchema = z.object({
	return_url: z
		.string()
		.url()
		.refine((u) => urlMatchesAppOrigin(u), {
			message: 'return_url origin must match FRONTEND_URL',
		}),
})

function urlMatchesAppOrigin(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).origin === new URL(frontendBaseUrl()).origin
	} catch {
		return false
	}
}

const portalResponseSchema = z.object({
	url: z.string().url(),
})

const portalRoute = createRoute({
	method: 'post',
	path: '/portal',
	tags: ['billing'],
	summary: 'Open a Stripe Billing Portal session for this workspace',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: portalBodySchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Billing portal session created',
			content: { 'application/json': { schema: portalResponseSchema } },
		},
		404: {
			description: 'Workspace not found or no Stripe customer on record',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe misconfigured or upstream failure',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(portalRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { return_url } = c.req.valid('json')

	const [workspace] = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settingsParse = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const customerId = settingsParse.success
		? (settingsParse.data.billing?.stripe_customer_id ?? null)
		: null

	// The frontend gates the "Manage in Stripe" affordance behind
	// `isPaid && usage.stripe_customer_id`, so reaching this endpoint without
	// a customer id is a caller bug, not a user-facing state. 404 keeps the
	// contract obvious: there is nothing to manage.
	if (!customerId) {
		return c.json(
			createApiError('NOT_FOUND', 'No Stripe customer on record for this workspace'),
			404,
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
		const session = await createBillingPortalSession(stripe, {
			workspaceId,
			customerId,
			returnUrl: return_url,
		})
		if (!session.url) {
			logger.error('Stripe billing portal session missing url', { sessionId: session.id })
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe returned no portal url'), 500)
		}
		return c.json({ url: session.url }, 200)
	} catch (err) {
		logger.error('Stripe billing portal session creation failed', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create billing portal session'), 500)
	}
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

export default app
