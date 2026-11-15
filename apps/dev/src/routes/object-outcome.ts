import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { blindMarkSchema, endOutcomeSchema, outcomeStateResponseSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import {
	OutcomeCheckError,
	acceptOutcome,
	endOutcomeByPerson,
	getOutcomeState,
	recordBlindMarks,
} from '../lib/outcome-check'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * What the outcome check stored for a job: its rounds, how checking ended, and whether a person
 * accepted the work. The check itself runs inside the update that closes a job (PATCH
 * /api/objects/{id}), never from a route an agent calls. This file holds the read and the three
 * writes only a person can make. See lib/outcome-check.ts.
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

function mapError(err: OutcomeCheckError) {
	const error = createApiError(err.code, err.message)
	if (err.code === 'NOT_FOUND') return [error, 404] as const
	if (err.code === 'FORBIDDEN') return [error, 403] as const
	if (err.code === 'CONFLICT') return [error, 409] as const
	return [error, 400] as const
}

/** A person from their own client: not an agent, and not a call through MCP. */
function isPersonClient(actorType: string, clientSource: string | undefined) {
	return actorType === 'human' && clientSource !== 'mcp'
}

const notAPerson = (what: string) => createApiError('FORBIDDEN', `Only a person can ${what}.`)

const getRoute = createRoute({
	method: 'get',
	path: '/{id}/outcome',
	tags: ['Objects'],
	summary: 'The outcome check of a job',
	description:
		'Every stored check round of the job (one mark per line, who made it, the readings used), how checking ended (checks_passed, sent_back, round_limit_reached, list_does_not_fit, stopped_by_person) and, as a separate field, whether a person accepted the work.',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'The stored rounds and endings',
			content: { 'application/json': { schema: outcomeStateResponseSchema } },
		},
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getRoute, async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const [object] = await db
		.select({ id: objects.id, workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, id))
		.limit(1)
	if (!object) return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	return c.json(await getOutcomeState(db, id), 200)
})

const acceptRoute = createRoute({
	method: 'post',
	path: '/{id}/outcome/accept',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Accept the work of a job',
	description:
		'A person accepting the work. Separate from the check: "checks passed" is never accepted until a person says so here. Only a person, from their own client.',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'The outcome after the change',
			content: { 'application/json': { schema: outcomeStateResponseSchema } },
		},
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(acceptRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	if (!isPersonClient(c.get('actorType'), c.req.header(CLIENT_SOURCE_HEADER)))
		return c.json(notAPerson('accept the work'), 403)
	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		return c.json(await acceptOutcome(db, { objectId: id, actorId }), 200)
	} catch (err) {
		if (err instanceof OutcomeCheckError) {
			const [error, status] = mapError(err)
			return c.json(error, status)
		}
		throw err
	}
})

const endRoute = createRoute({
	method: 'post',
	path: '/{id}/outcome/end',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'End the outcome check of a job',
	description:
		'A person ending the checking: the list does not fit the work (list_does_not_fit), or they stopped it (stopped_by_person). Only a person, from their own client.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: endOutcomeSchema } } },
	},
	responses: {
		200: {
			description: 'The outcome after the change',
			content: { 'application/json': { schema: outcomeStateResponseSchema } },
		},
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(endRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	if (!isPersonClient(c.get('actorType'), c.req.header(CLIENT_SOURCE_HEADER)))
		return c.json(notAPerson('end the check'), 403)
	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		return c.json(await endOutcomeByPerson(db, { objectId: id, actorId, ending: body.ending }), 200)
	} catch (err) {
		if (err instanceof OutcomeCheckError) {
			const [error, status] = mapError(err)
			return c.json(error, status)
		}
		throw err
	}
})

const blindRoute = createRoute({
	method: 'post',
	path: '/{id}/outcome/blind-marks',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Mark lines for the blind sample',
	description:
		"A person's own yes or no for lines of the job's approved list, made without seeing the checker's marks. Stored next to the rounds and compared with the checker's marks to measure agreement. Only a person, from their own client.",
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: blindMarkSchema } } },
	},
	responses: {
		200: {
			description: 'The outcome after the change',
			content: { 'application/json': { schema: outcomeStateResponseSchema } },
		},
		400: {
			description: 'No approved list, or a line that is not on it',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(blindRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	if (!isPersonClient(c.get('actorType'), c.req.header(CLIENT_SOURCE_HEADER)))
		return c.json(notAPerson('mark lines in the blind sample'), 403)
	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		return c.json(await recordBlindMarks(db, { objectId: id, actorId, marks: body.marks }), 200)
	} catch (err) {
		if (err instanceof OutcomeCheckError) {
			const [error, status] = mapError(err)
			return c.json(error, status)
		}
		throw err
	}
})

export default app
