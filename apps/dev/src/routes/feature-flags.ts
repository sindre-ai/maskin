import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { validationFailureHook } from '../lib/errors'
import { FLAGS, getFeatureFlagConfig, resolveFlags } from '../lib/feature-flags'

// Per-actor, not per-workspace — no X-Workspace-Id header.
type Env = {
	Variables: {
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const featureFlagsResponseSchema = z.object({
	flags: z.record(z.boolean()).openapi({ example: { [FLAGS.NEW_DESIGN]: true } }),
})

const getFlagsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Feature Flags'],
	summary: 'Resolved feature flags for the calling actor',
	description:
		'Returns only the resolved booleans. The tester actor id list and the raw environment config are never exposed — tester identities stay server-side.',
	responses: {
		200: {
			description: 'Resolved flags',
			content: { 'application/json': { schema: featureFlagsResponseSchema } },
		},
	},
})

app.openapi(getFlagsRoute, (c) => {
	const flags = resolveFlags(c.get('actorId'), getFeatureFlagConfig())
	// A rollback must not be defeated by a stale cached response.
	c.header('Cache-Control', 'no-store')
	return c.json({ flags }, 200)
})

export default app
