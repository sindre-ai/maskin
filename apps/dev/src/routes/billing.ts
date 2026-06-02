import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessions, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { createCheckoutSession, getStripeClient, readStripeEnv } from '../lib/stripe'

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

/**
 * Mirror the response schema (`z.number().int().nonnegative()`) at read so a
 * malformed stored `period_start` (negative, float, non-finite) degrades to
 * `null` + a fresh trial window instead of crashing the OpenAPI response
 * validator and taking the whole row dark.
 */
function normalizePeriodStart(raw: unknown): number | null {
	if (typeof raw !== 'number') return null
	if (!Number.isInteger(raw)) return null
	if (raw < 0) return null
	return raw
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
	plan: z.enum(['starter', 'pro']),
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
	const periodStart = normalizePeriodStart(billing?.period_start)
	const periodStartMs = periodStart !== null ? periodStart * 1000 : Date.now() - TRIAL_WINDOW_MS
	const periodEndMs =
		periodStart !== null
			? // Stripe periods are 28-31d; we don't store period_end on this branch,
				// so we approximate as "30d from period_start" for the resets-in hint.
				periodStart * 1000 + TRIAL_WINDOW_MS
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
			period_start: periodStart,
			period_resets_in_ms: plan === 'byollm' ? null : resetsIn,
			stripe_customer_id: billing?.stripe_customer_id ?? null,
			stripe_subscription_id: billing?.stripe_subscription_id ?? null,
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

export default app
