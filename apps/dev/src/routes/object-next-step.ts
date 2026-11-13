import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import {
	nextStepResponseSchema,
	scheduleNextStepResponseSchema,
	scheduleNextStepSchema,
	setNextStepSchema,
	updateNextStepSchema,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	NextStepError,
	scheduleNextStep,
	serializeNextStep,
	setNextStep,
	updateNextStep,
} from '../lib/next-steps'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import { isWorkspaceWriter } from '../lib/workspace-auth'
import { assertScheduledWorkWithinCap } from '../services/self-start-limits'

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
		actorType?: string
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
		409: {
			description: 'The step has a wake-up for its current owner, so the owner cannot be changed',
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
			if (err.code === 'NOT_FOUND') return c.json(error, 404)
			// Conflict on update: a step with a wake-up cannot be handed to a new owner by an edit.
			if (err.code === 'CONFLICT') return c.json(error, 409)
			return c.json(error, 400)
		}
		throw err
	}
})

const scheduleRoute = createRoute({
	method: 'post',
	path: '/{id}/schedule-next-step',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Set the next step and its wake-up in one call',
	description:
		'Sets the object’s next step and makes sure someone comes back for it. Owner is the caller (an agent): a one-off wake-up is saved for them, pinned to this object and step, and cancelled if the step is closed or replaced. Owner is another agent: a task is created with that agent as driver and the step waits on it. Owner is a person: the step is stored and nobody is woken. 409 when the object already has an open or blocked step unless replace is true. 429 when the caller already has too many wake-ups waiting from runs that started on their own.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: scheduleNextStepSchema } } },
	},
	responses: {
		201: {
			description: 'The new step and what backs it',
			content: { 'application/json': { schema: scheduleNextStepResponseSchema } },
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
		429: {
			description: 'Too many wake-ups waiting from runs that started on their own',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(scheduleRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const object = await writableObject(db, actorId, id)
	if (!object) return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)

	// Only an agent that wakes itself leaves a timer behind, so only that case counts against the
	// cap on pending wake-ups. A run a person started is not limited here.
	const wakesItself = c.get('actorType') === 'agent' && (body.owner_id ?? actorId) === actorId
	const { createdFromStartReason } = wakesItself
		? await assertScheduledWorkWithinCap(db, {
				workspaceId: object.workspaceId,
				actorId,
				sessionId: c.get('maskinSessionId'),
			})
		: { createdFromStartReason: null }

	try {
		const result = await db.transaction((tx) =>
			scheduleNextStep(
				tx,
				{ objectId: id, actorId, sessionId: c.get('maskinSessionId'), createdFromStartReason },
				body,
			),
		)
		return c.json({ next_step: serializeNextStep(result.step), wake_up: result.wakeUp }, 201)
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

export default app
