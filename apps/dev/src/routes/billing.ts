import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { createCheckoutSession, getStripeClient, readStripeEnv } from '../lib/stripe'

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
