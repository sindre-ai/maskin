import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { goAheadResponseSchema, recordGoAheadSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { GoAheadError, recordGoAhead, takeBackGoAhead } from '../lib/go-aheads'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * A person's go-ahead on a job: "keep going without asking me for each step". Stored in its own
 * table, never on the object, so no writer of the object can edit it and an agent cannot grant
 * itself the yes. An agent may record what a person said (quoting the person's chat message) and
 * may take a go-ahead back; it cannot grant one. The current go-ahead also comes back on
 * GET /api/objects/{id} as go_ahead. See lib/go-aheads.ts.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
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

const recordRoute = createRoute({
	method: 'post',
	path: '/{id}/go-ahead',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Record a person’s go-ahead on a job',
	description:
		'Stores a person’s yes to keep going on this job without asking for each step. via chat: quote the message (message_id) in which a person said it; it must exist, be written by a person (not an agent) and sit in a chat about this job. via card: only a person may call it, when they approve a card. A go-ahead by an agent is always refused. The go-ahead never covers sending in a person’s name, spending or deleting, and ends when the job closes. 200 with the existing go-ahead when the job already has one.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: recordGoAheadSchema } } },
	},
	responses: {
		200: {
			description: 'The job already had a go-ahead; it is unchanged',
			content: { 'application/json': { schema: goAheadResponseSchema } },
		},
		201: {
			description: 'The go-ahead as recorded',
			content: { 'application/json': { schema: goAheadResponseSchema } },
		},
		400: {
			description: 'The quoted message is not in a chat about this job, or the job is closed',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not given by a person',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Object not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(recordRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		const result = await db.transaction((tx) => recordGoAhead(tx, { objectId: id, actorId }, body))
		if (result.created) return c.json(result.goAhead, 201)
		return c.json(result.goAhead, 200)
	} catch (err) {
		if (err instanceof GoAheadError) {
			const error = createApiError(err.code, err.message)
			if (err.code === 'NOT_FOUND') return c.json(error, 404)
			if (err.code === 'FORBIDDEN') return c.json(error, 403)
			return c.json(error, 400)
		}
		throw err
	}
})

const takeBackRoute = createRoute({
	method: 'delete',
	path: '/{id}/go-ahead',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Take a go-ahead back',
	description:
		'Ends the job’s go-ahead. A person or an agent may call it. The next session on the job sees no go-ahead and asks again for anything that is not a safe step. 404 when the job has none.',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'The go-ahead that was taken back',
			content: { 'application/json': { schema: goAheadResponseSchema } },
		},
		404: {
			description: 'Object not found, or it has no go-ahead',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(takeBackRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	if (!(await writableObject(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}
	try {
		const goAhead = await db.transaction((tx) => takeBackGoAhead(tx, { objectId: id, actorId }))
		return c.json(goAhead, 200)
	} catch (err) {
		// takeBackGoAhead only ever refuses with NOT_FOUND.
		if (err instanceof GoAheadError) return c.json(createApiError(err.code, err.message), 404)
		throw err
	}
})

export default app
