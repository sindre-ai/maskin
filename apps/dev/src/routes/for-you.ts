import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { createApiError, validationFailureHook } from '../lib/errors'
import { buildForYouItems, forYouItemSchema } from '../lib/for-you-items'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const forYouResponseSchema = z.object({ items: z.array(forYouItemSchema) })

const listForYouRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['For You'],
	summary:
		"What needs the current actor: the Chief of Staff's ranked list, then decision cards addressed to them",
	request: {
		headers: workspaceIdHeader,
		query: z.object({
			for_actor_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					"Read another member's list. Agents may ask for any member; a person may only ask for their own.",
				),
		}),
	},
	responses: {
		200: {
			description: 'Ranked For You items, already filtered against live state',
			content: { 'application/json': { schema: forYouResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: "A person asked for someone else's list",
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'for_actor_id is not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listForYouRoute, async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { for_actor_id: forActorId } = c.req.valid('query')

	let actorId = callerId
	if (forActorId && forActorId !== callerId) {
		if (c.get('actorType') !== 'agent') {
			return c.json(createApiError('FORBIDDEN', 'You can only read your own For You list'), 403)
		}
		if (!(await isWorkspaceMember(db, forActorId, workspaceId))) {
			return c.json(createApiError('NOT_FOUND', 'Actor not found in this workspace'), 404)
		}
		actorId = forActorId
	}

	return c.json({ items: await buildForYouItems(db, workspaceId, actorId) }, 200)
})

export default app
