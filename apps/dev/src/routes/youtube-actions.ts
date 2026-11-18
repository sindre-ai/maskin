import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { youtubePendingActions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { decideYoutubeAction } from '../lib/youtube/actions'
import { scheduleYoutubeExecution } from '../lib/youtube/executor'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		storageProvider?: StorageProvider
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const idParam = z.object({ id: z.string().uuid() })

const statusSchema = z.object({
	id: z.string().uuid(),
	kind: z.string(),
	status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']),
	result_code: z.string().nullable(),
	expires_at: z.string(),
	decided_at: z.string().nullable(),
})

const getRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['YouTube'],
	summary:
		'Where a held YouTube change stands: pending, decided, and how it ended. Never its content.',
	request: { headers: workspaceIdHeader, params: idParam },
	responses: {
		200: {
			description: 'The action',
			content: { 'application/json': { schema: statusSchema } },
		},
		404: {
			description: 'No such action',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getRoute, async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const [row] = await c
		.get('db')
		.select()
		.from(youtubePendingActions)
		.where(
			and(eq(youtubePendingActions.id, id), eq(youtubePendingActions.workspaceId, workspaceId)),
		)
		.limit(1)
	if (!row) return c.json(createApiError('NOT_FOUND', 'No such YouTube change'), 404)
	return c.json(
		{
			id: row.id,
			kind: row.kind,
			status: row.status as z.infer<typeof statusSchema>['status'],
			result_code: row.resultCode,
			expires_at: row.expiresAt.toISOString(),
			decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
		},
		200,
	)
})

const decisionBody = z.object({
	decision: z.enum(['approve', 'reject']),
	payload_hash: z
		.string()
		.length(64)
		.optional()
		.describe('The hash of the request the person was shown. Required to approve.'),
})

const decisionRoute = createRoute({
	method: 'post',
	path: '/{id}/decision',
	'x-viewer-policy': 'writer',
	tags: ['YouTube'],
	summary:
		'A person approves or rejects a held YouTube change. People only: an agent, or a call through MCP, is refused. An approved change runs once, from the server.',
	request: {
		headers: workspaceIdHeader,
		params: idParam,
		body: { content: { 'application/json': { schema: decisionBody } } },
	},
	responses: {
		200: {
			description: 'Decided. An approved change is now running.',
			content: { 'application/json': { schema: statusSchema } },
		},
		400: {
			description: 'Approval without a payload hash',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: {
			description: 'No such action',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Already decided, expired, or the request no longer matches its hash',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(decisionRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	if (body.decision === 'approve' && !body.payload_hash) {
		return c.json(
			createApiError('BAD_REQUEST', 'Approving needs the payload_hash the person was shown'),
			400,
		)
	}
	// A model holding a person's key is not that person (same rule as every other approval).
	const actorType = c.req.header(CLIENT_SOURCE_HEADER) === 'mcp' ? 'agent' : c.get('actorType')

	const result = await db.transaction((tx) =>
		decideYoutubeAction(tx, {
			workspaceId,
			actionId: id,
			actor: { id: c.get('actorId'), type: actorType },
			decision: body.decision,
			expectedHash: body.payload_hash,
		}),
	)
	if (!result.ok) {
		switch (result.reason) {
			case 'not_found':
				return c.json(createApiError('NOT_FOUND', 'No such YouTube change'), 404)
			case 'agent_actor':
				return c.json(createApiError('FORBIDDEN', 'Only a person can decide a YouTube change'), 403)
			case 'expired':
				return c.json(createApiError('CONFLICT', 'That YouTube change has expired'), 409)
			case 'payload_changed':
				return c.json(
					createApiError(
						'CONFLICT',
						'The request no longer matches what was shown, so it was not approved',
					),
					409,
				)
			default:
				return c.json(
					createApiError('CONFLICT', 'That YouTube change has already been decided'),
					409,
				)
		}
	}
	if (result.decision === 'approve') scheduleYoutubeExecution(db, id, c.get('storageProvider'))
	const a = result.action
	return c.json(
		{
			id: a.id,
			kind: a.kind,
			status: a.status as z.infer<typeof statusSchema>['status'],
			result_code: a.resultCode,
			expires_at: a.expiresAt.toISOString(),
			decided_at: a.decidedAt ? a.decidedAt.toISOString() : null,
		},
		200,
	)
})

export default app
