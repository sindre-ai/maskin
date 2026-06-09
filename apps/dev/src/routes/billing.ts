import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessions, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import {
	PRO_HARD_CAP_DEFAULT_TOKENS,
	STARTER_HARD_CAP_DEFAULT_TOKENS,
	parsePositiveIntEnv,
} from '../lib/billing-defaults'
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
 * The trial fallback is intentionally a literal — the hard-cap enforcement
 * path reads `MASKIN_TRIAL_HARD_CAP_TOKENS` for trial workspaces, but this
 * route is the Settings row's display value and stays on a deterministic
 * literal so the UI never depends on a deploy-time env var being set.
 */
const DEFAULT_TRIAL_HARD_CAP_TOKENS = 100_000
const TRIAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Fallback hard caps for paid plans when `billing.hard_cap_tokens` hasn't been
 * populated yet (delayed Stripe webhook, partial state after a webhook
 * failure). Read from env first via the shared `parsePositiveIntEnv` (so
 * `lib/stripe.ts`'s boot-time strict parse and this defensive read agree on
 * what a "valid" cap looks like), then fall through to the documented
 * literals. We parse env locally instead of reusing `readStripeEnv` because
 * that helper throws when Stripe is unconfigured, and `/api/billing/usage`
 * must keep serving usage to workspaces regardless.
 */
function planHardCapFallback(plan: 'trial' | 'starter' | 'pro' | 'byollm'): number | null {
	switch (plan) {
		case 'trial':
		case 'byollm':
			return DEFAULT_TRIAL_HARD_CAP_TOKENS
		case 'starter':
			return (
				parsePositiveIntEnv('MASKIN_STARTER_HARD_CAP_TOKENS') ?? STARTER_HARD_CAP_DEFAULT_TOKENS
			)
		case 'pro':
			return parsePositiveIntEnv('MASKIN_PRO_HARD_CAP_TOKENS') ?? PRO_HARD_CAP_DEFAULT_TOKENS
	}
}

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

/**
 * Resolve a Stripe client + env, or return the 500 response that should be sent
 * back to the caller. Centralises the "Stripe is not configured" log so every
 * Stripe-touching route surfaces misconfiguration with the same shape.
 */
function getStripeOrError(c: Context<Env>) {
	let env: ReturnType<typeof readStripeEnv>
	try {
		env = readStripeEnv()
	} catch (err) {
		logger.error('Stripe is not configured', {
			error: err instanceof Error ? err.message : String(err),
		})
		return {
			ok: false as const,
			response: c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500),
		}
	}
	return { ok: true as const, stripe: getStripeClient(env), env }
}

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
		.select({
			id: workspaces.id,
			settings: workspaces.settings,
			createdAt: workspaces.createdAt,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const parsed = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	if (!parsed.success) {
		logger.warn('Malformed workspace billing settings', { workspaceId })
	}
	const billing = parsed.success ? parsed.data.billing : undefined

	const plan = billing?.plan ?? 'trial'
	const status = billing?.status ?? 'active'
	const hardCap =
		billing?.hard_cap_tokens && billing.hard_cap_tokens > 0
			? billing.hard_cap_tokens
			: planHardCapFallback(plan)
	// Trial workspaces have no Stripe `period_start`, so anchor the window to
	// `workspaces.createdAt` and roll forward in fixed 30d cycles.
	const now = Date.now()
	const trialOrigin = workspace.createdAt?.getTime() ?? now
	const elapsedSinceOrigin = Math.max(0, now - trialOrigin)
	const trialCycleStartMs =
		trialOrigin + Math.floor(elapsedSinceOrigin / TRIAL_WINDOW_MS) * TRIAL_WINDOW_MS
	// `billing.period_start` is a Unix SECONDS value. Floor positive values so
	// a Stripe-written float doesn't trip the response schema; null for anything
	// malformed (negative, non-finite, non-number).
	const rawPeriodStart = billing?.period_start
	const periodStartSec =
		typeof rawPeriodStart === 'number' && Number.isFinite(rawPeriodStart) && rawPeriodStart > 0
			? Math.floor(rawPeriodStart)
			: null
	const periodStartMs = periodStartSec !== null ? periodStartSec * 1000 : trialCycleStartMs
	const periodEndMs = periodStartMs + TRIAL_WINDOW_MS

	let tokensUsed = 0
	if (plan !== 'byollm') {
		const since = new Date(periodStartMs)
		// Single SQL aggregate keeps this route O(1) over sessions-per-period.
		// Supported by the partial index `sessions_maskin_plan_period_idx` on
		// `(workspace_id, created_at) WHERE config->>'llm_route' = 'maskin_plan'`.
		const [agg] = await db
			.select({
				total: sql<number>`COALESCE(SUM(COALESCE(${sessions.inputTokens}, 0) + COALESCE(${sessions.outputTokens}, 0)), 0)::int`,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					gte(sessions.createdAt, since),
					sql`${sessions.config}->>'llm_route' = ${LLM_ROUTE_MASKIN_PLAN}`,
				),
			)
		tokensUsed = agg?.total ?? 0
	}

	const resetsIn = Math.max(0, periodEndMs - now)

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
			period_start: periodStartSec,
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
		})
		.openapi({
			description:
				'URL Stripe redirects to after the user closes the Billing Portal. Must use the same origin (scheme + host + port) as the configured FRONTEND_URL — cross-origin values are rejected with a 400.',
		}),
})

function urlMatchesAppOrigin(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).origin === new URL(frontendBaseUrl()).origin
	} catch (err) {
		// Only swallow `new URL(...)` failures on user-supplied input — those
		// resolve to "origin doesn't match" (return false → 400). Anything else,
		// notably `frontendBaseUrl()` throwing because FRONTEND_URL is unset in
		// production, is a configuration bug and must propagate as a 500 so the
		// signal isn't lost in a sea of 400s.
		if (err instanceof TypeError) return false
		throw err
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
		400: {
			description:
				'Invalid request body (malformed return_url, or origin does not match FRONTEND_URL)',
			content: { 'application/json': { schema: errorSchema } },
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

	const stripeOrError = getStripeOrError(c)
	if (!stripeOrError.ok) return stripeOrError.response
	const { stripe } = stripeOrError
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

	const stripeOrError = getStripeOrError(c)
	if (!stripeOrError.ok) return stripeOrError.response
	const { stripe, env: stripeEnv } = stripeOrError
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
