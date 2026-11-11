import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { nextStepResponseSchema, setNextStepSchema, updateNextStepSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { NextStepError, serializeNextStep, setNextStep, updateNextStep } from '../lib/next-steps'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * The next step on a driven object: what happens next, who does it and by when. Agents write
 * it only here (and through the MCP tools behind these routes); it is not a field on the
 * object, so the generic object update cannot touch it. The current step also comes back on
 * GET /api/objects/{id} as next_step. See lib/next-steps.ts.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		maskinSessionId?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** The object's workspace, once the caller is allowed to write in it. Null reads as 404. */
async function writableObject(db: Database, actorId: string, objectId: string) {
	const [object] = await db
		.select({ id: objects.id, workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, objectId))
		.limit(1)
	if (!object || !(await isWorkspaceWriter(db, actorId, object.workspaceId))) return null
	return object
}

const setRoute = createRoute({
	method: 'post',
	path: '/{id}/next-step',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Set the next step on an object',
	description:
		'Gives the object its next step: the action, who does it (defaults to the caller) and when it is due. An object has at most one open or blocked step: a second one is refused with 409 unless replace is true, which closes the old one as skipped. Pass one blocked_on field to create it already blocked.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: setNextStepSchema } } },
	},
	responses: {
		201: {
			description: 'The new step',
			content: { 'application/json': { schema: nextStepResponseSchema } },
		},
		400: {
			description: 'Invalid step: a rule was broken (see the message)',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'The object already has an open or blocked step',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(setRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		const row = await db.transaction((tx) =>
			setNextStep(tx, { objectId: id, actorId, sessionId: c.get('maskinSessionId') }, body),
		)
		return c.json(serializeNextStep(row), 201)
	} catch (err) {
		if (err instanceof NextStepError) {
			const error = createApiError(err.code, err.message)
			if (err.code === 'NOT_FOUND') return c.json(error, 404)
			if (err.code === 'CONFLICT') return c.json(error, 409)
			return c.json(error, 400)
		}
		throw err
	}
})

const updateRoute = createRoute({
	method: 'patch',
	path: '/{id}/next-step',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Change or close the next step on an object',
	description:
		'Changes the object’s open or blocked step: its action, owner, due time, or its state. status done or skipped closes it and needs evidence. status blocked needs exactly one blocked_on field; open clears it. 404 when the object has no open or blocked step.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateNextStepSchema } } },
	},
	responses: {
		200: {
			description: 'The step as it is now (a closed step comes back with its closed_at)',
			content: { 'application/json': { schema: nextStepResponseSchema } },
		},
		400: {
			description: 'Invalid step: a rule was broken (see the message)',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Object not found, or it has no open or blocked step to change',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		const row = await db.transaction((tx) =>
			updateNextStep(tx, { objectId: id, actorId, sessionId: c.get('maskinSessionId') }, body),
		)
		return c.json(serializeNextStep(row), 200)
	} catch (err) {
		if (err instanceof NextStepError) {
			const error = createApiError(err.code, err.message)
			// Updating never raises a conflict: the one-live-step rule is only checked on set.
			if (err.code === 'NOT_FOUND') return c.json(error, 404)
			return c.json(error, 400)
		}
		throw err
	}
})

export default app
