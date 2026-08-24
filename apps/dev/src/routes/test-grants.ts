import { timingSafeEqual } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'

/**
 * Test-only entitlement grants.
 *
 * The two things E2E specs need — a paid-plan tier (for seat / ownership
 * headroom) and the BYO-LLM entitlement — are both deliberately NOT
 * self-service in the product:
 *
 *   - `settings.billing` is rejected by PATCH /api/workspaces/:id, because
 *     Stripe owns it and accepting it would be a free paid plan.
 *   - `byollm_allowed` on PATCH /api/workspaces/admin/:id requires an ops actor
 *     on MASKIN_ENTERPRISE_ACTOR_IDS, because it bypasses the plan cap.
 *
 * E2E is pure HTTP with no DB access, and its actors are created through public
 * signup with server-generated UUIDs, so they cannot be pre-listed on the ops
 * allowlist. This route is that seam, and nothing else: it exists ONLY when
 * MASKIN_TEST_GRANT_TOKEN is set, and app-factory does not mount it otherwise —
 * in production the path 404s because the routes were never registered.
 *
 * Fails closed by absence rather than on `NODE_ENV`: an env var that nobody
 * sets in production is a stronger guarantee than a string that has to be
 * correct in production. Callers must still present a valid API key (the normal
 * auth middleware runs first), so the token is a second factor, not the only
 * one.
 */
type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const TEST_GRANT_HEADER = 'X-Test-Grant-Token'

export function isTestGrantEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return typeof env.MASKIN_TEST_GRANT_TOKEN === 'string' && env.MASKIN_TEST_GRANT_TOKEN.length > 0
}

/** Constant-time compare so the token can't be recovered a byte at a time. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
	if (!provided) return false
	const a = Buffer.from(provided)
	const b = Buffer.from(expected)
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

const grantBodySchema = z
	.object({
		plan: z.enum(['trial', 'pro', 'team']).optional(),
		byollm_allowed: z.boolean().optional(),
	})
	.refine((v) => v.plan !== undefined || v.byollm_allowed !== undefined, {
		message: 'At least one of plan or byollm_allowed must be provided',
	})

const grantRoute = createRoute({
	method: 'post',
	path: '/{id}',
	tags: ['test-grants'],
	summary: 'Grant a test workspace a plan tier / BYO-LLM entitlement (test stacks only)',
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: { content: { 'application/json': { schema: grantBodySchema } } },
	},
	responses: {
		200: {
			description: 'Grant applied',
			content: {
				'application/json': {
					schema: z.object({ ok: z.literal(true) }),
				},
			},
		},
		403: {
			description: 'Missing or invalid test-grant token',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(grantRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const expected = process.env.MASKIN_TEST_GRANT_TOKEN
	// Re-checked per request, not just at mount: the route object could outlive
	// a config change, and an unset token must never mean "allow".
	if (!expected || !tokenMatches(c.req.header(TEST_GRANT_HEADER), expected)) {
		return c.json(createApiError('FORBIDDEN', 'Invalid test-grant token'), 403)
	}

	const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
	if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	const update: Record<string, unknown> = { updatedAt: new Date() }
	if (body.byollm_allowed !== undefined) update.byollmAllowed = body.byollm_allowed
	if (body.plan !== undefined) {
		// Spread the RAW settings row, not a Zod-parsed copy: parsing strips
		// unknown keys and drops everything on a validation failure.
		const settings = (existing.settings ?? {}) as Record<string, unknown>
		const billing = (settings.billing ?? {}) as Record<string, unknown>
		update.settings = {
			...settings,
			billing: { ...billing, plan: body.plan, status: 'active' },
		}
	}

	await db.update(workspaces).set(update).where(eq(workspaces.id, id))

	await db.insert(events).values({
		workspaceId: id,
		actorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: id,
		data: { test_grant: { plan: body.plan, byollm_allowed: body.byollm_allowed } },
	})

	return c.json({ ok: true as const }, 200)
})

export default app
