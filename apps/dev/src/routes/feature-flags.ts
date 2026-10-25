import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { validationFailureHook } from '../lib/errors'
import {
	FLAGS,
	getFeatureFlagConfig,
	isFlagEnabledForWorkspace,
	resolveFlags,
} from '../lib/feature-flags'
import { isWorkspaceMember } from '../lib/workspace-auth'

// Per-actor by default. An optional X-Workspace-Id header adds that workspace's
// workspace-scoped enables, for callers who are members of it.
type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const featureFlagsResponseSchema = z.object({
	flags: z.record(z.boolean()).openapi({ example: { 'some-flag': true } }),
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

app.openapi(getFlagsRoute, async (c) => {
	const actorId = c.get('actorId')
	const config = getFeatureFlagConfig()
	const flags = resolveFlags(actorId, config)
	// Optional X-Workspace-Id, read off the request and deliberately not declared in the route
	// spec so the published OpenAPI document (and the generated native client) stays as it is.
	// The header alone is never trusted: a workspace's flags are only revealed to
	// a member of it. A non-member, or a malformed id, gets the actor-only answer.
	const workspaceId = c.req.header('X-Workspace-Id')
	if (
		workspaceId &&
		UUID_RE.test(workspaceId) &&
		(await isWorkspaceMember(c.get('db'), actorId, workspaceId))
	) {
		for (const flagId of Object.values(FLAGS)) {
			if (flags[flagId]) continue
			flags[flagId] = isFlagEnabledForWorkspace(workspaceId, flagId, { flagConfig: config })
		}
	}
	// A rollback must not be defeated by a stale cached response.
	c.header('Cache-Control', 'no-store')
	return c.json({ flags }, 200)
})

export default app
