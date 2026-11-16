import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { doneWhenLines, objects } from '@maskin/db/schema'
import {
	doneWhenResponseSchema,
	doneWhenSkipResponseSchema,
	setDoneWhenLineSchema,
	skipDoneWhenSchema,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { DoneWhenError, setLineState, skipDoneWhen } from '../lib/done-when'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * A job's done-when list. The list itself is proposed on a decision card (create_comment with a
 * done_when block) and approved by a person's tap on that card, written by the server in the same
 * write as their reply (routes/events.ts). This file holds the two other writes: the agent's
 * "list skipped, because X", and a person ticking a line. The current list comes back on
 * GET /api/objects/{id} as done_when. See lib/done-when.ts.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

async function writableObject(db: Database, actorId: string, objectId: string) {
	const [object] = await db
		.select({ id: objects.id, workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, objectId))
		.limit(1)
	if (!object || !(await isWorkspaceWriter(db, actorId, object.workspaceId))) return null
	return object
}

function mapError(err: DoneWhenError) {
	const error = createApiError(err.code, err.message)
	if (err.code === 'NOT_FOUND') return [error, 404] as const
	if (err.code === 'FORBIDDEN') return [error, 403] as const
	return [error, 400] as const
}

const skipRoute = createRoute({
	method: 'post',
	path: '/{id}/done-when/skip',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Skip the done-when list on a job',
	description:
		'Records "list skipped, because X" on a job that needs no done-when list: one session can finish it, it undoes cleanly, nothing in it sends, spends or deletes, and no target is behind it. Refused (403) on a bet, a target or a job with a target behind it, and logged. Skips are counted. 400 when the job already has a list.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: skipDoneWhenSchema } } },
	},
	responses: {
		200: {
			description: 'The skip as recorded',
			content: { 'application/json': { schema: doneWhenSkipResponseSchema } },
		},
		400: {
			description: 'The job already has a list',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'This job may not skip its list',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(skipRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		const skip = await skipDoneWhen(db, { objectId: id, actorId, reason: body.reason })
		return c.json(skip, 200)
	} catch (err) {
		if (err instanceof DoneWhenError) {
			const [error, status] = mapError(err)
			return c.json(error, status)
		}
		throw err
	}
})

const lineParamSchema = idParamSchema.extend({ lineId: z.string().uuid() })

const setLineRoute = createRoute({
	method: 'patch',
	path: '/{id}/done-when/lines/{lineId}',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Tick a line of the done-when list',
	description:
		'Sets the state of one line (true, false, cannot_tell, not_checked) on an approved list. Only a person, from their own client, may do this: an agent, or a call through MCP, is refused (403). Until the outcome check lands this is how a line becomes true.',
	request: {
		params: lineParamSchema,
		body: { content: { 'application/json': { schema: setDoneWhenLineSchema } } },
	},
	responses: {
		200: {
			description: 'The list after the change',
			content: { 'application/json': { schema: doneWhenResponseSchema } },
		},
		400: {
			description: 'The list is not approved',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a person',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Object or line not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(setLineRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id, lineId } = c.req.valid('param')
	const body = c.req.valid('json')

	if (c.get('actorType') !== 'human' || c.req.header(CLIENT_SOURCE_HEADER) === 'mcp') {
		return c.json(
			createApiError('FORBIDDEN', 'Only a person can tick a line of the done-when list.'),
			403,
		)
	}
	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	const [line] = await db
		.select({ objectId: doneWhenLines.objectId })
		.from(doneWhenLines)
		.where(eq(doneWhenLines.id, lineId))
		.limit(1)
	if (!line || line.objectId !== id) {
		return c.json(createApiError('NOT_FOUND', 'Line not found'), 404)
	}
	try {
		const list = await db.transaction((tx) =>
			setLineState(tx, { lineId, actorId, state: body.state }),
		)
		return c.json(list, 200)
	} catch (err) {
		if (err instanceof DoneWhenError) {
			const [error, status] = mapError(err)
			return c.json(error, status)
		}
		throw err
	}
})

export default app
