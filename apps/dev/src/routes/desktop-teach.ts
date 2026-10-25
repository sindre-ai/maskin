import { randomBytes } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { teachRequestSchema, teachResponseSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import {
	TEACH_FILE_TYPE,
	TEACH_RETENTION_MS,
	buildActionLog,
	buildReadme,
	buildTeachPrompt,
	decodeTeachFrames,
	frameFileName,
	teachDir,
} from '../lib/desktop-teach'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

// "Teach a task": a person's recorded demonstration on the workspace desktop
// becomes a draft skill, written by an agent they choose. This route stores the
// recording as that agent's files (pulled into its session at
// /agent/teach/<id>/) and starts the session. Same flag + membership boundary as
// the rest of /api/desktop.
//
// Header-scoped: authMiddleware has already confirmed workspace membership.
type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
		sessionManager: SessionManager
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const RECORDING_ID_RE = /^[0-9a-f]{12}$/

const teachRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Desktop'],
	summary: 'Teach an agent a task from a recorded demonstration on the desktop',
	description:
		'Stores the action log and screenshots as files for the chosen agent and starts a session in which it writes a draft skill. The recording is an input: delete it with DELETE /{recordingId} once the session ends; leftovers are swept after a few hours.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: teachRequestSchema } } },
	},
	responses: {
		201: {
			description: 'Recording stored and the learning session started',
			content: { 'application/json': { schema: teachResponseSchema } },
		},
		400: {
			description: 'Invalid recording',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Desktop not available, or the agent is not in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'Could not store the recording or start the session',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const deleteRoute = createRoute({
	method: 'delete',
	path: '/{recordingId}',
	tags: ['Desktop'],
	summary: 'Delete a teaching recording once the agent has learned from it',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ recordingId: z.string().regex(RECORDING_ID_RE) }),
		query: z.object({ agent_id: z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Deleted (idempotent)',
			content: { 'application/json': { schema: z.object({ deleted: z.number().int() }) } },
		},
		404: {
			description: 'Desktop not available',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

/** Deletes every stored file of one recording (or, with no id, every expired one). */
async function deleteRecordings(
	storage: AgentStorageManager,
	agentId: string,
	workspaceId: string,
	match: (path: string, updatedAt: Date | null) => boolean,
): Promise<number> {
	const records = await storage.listFileRecords(agentId, workspaceId, TEACH_FILE_TYPE)
	let deleted = 0
	for (const record of records) {
		if (!match(record.path, record.updatedAt ?? record.createdAt)) continue
		// `record.path` is `teach/<id>/...`; deleteFile re-adds the file type.
		const inner = record.path.slice(`${TEACH_FILE_TYPE}/`.length)
		try {
			await storage.deleteFile(agentId, workspaceId, TEACH_FILE_TYPE, inner)
			deleted++
		} catch (err) {
			logger.warn('teach recording file delete failed', { path: record.path, error: String(err) })
		}
	}
	return deleted
}

app.openapi(teachRoute, async (c) => {
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId')
	const db = c.get('db')
	const storage = c.get('agentStorage')
	const request = c.req.valid('json')

	// The learner must be an agent that belongs to this workspace.
	const [agent] = await db
		.select({ id: actors.id, name: actors.name })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(actors.id, request.agent_id),
				eq(actors.type, 'agent'),
				eq(workspaceMembers.workspaceId, workspaceId),
			),
		)
		.limit(1)
	if (!agent) {
		return c.json(createApiError('NOT_FOUND', 'Agent not found in this workspace'), 404)
	}

	const decoded = decodeTeachFrames(request)
	if (!decoded.ok) return c.json(createApiError('BAD_REQUEST', decoded.message), 400)

	// Opportunistic sweep of this agent's old recordings, so an abandoned one
	// (the person closed the tab before cleanup) cannot linger indefinitely.
	const cutoff = Date.now() - TEACH_RETENTION_MS
	await deleteRecordings(
		storage,
		agent.id,
		workspaceId,
		(_path, updatedAt) => updatedAt !== null && updatedAt.getTime() < cutoff,
	).catch((err) => logger.warn('teach recording sweep failed', { error: String(err) }))

	const recordingId = randomBytes(6).toString('hex')
	const base = teachDir(recordingId)
	const put = (path: string, data: Buffer) =>
		storage.uploadFile(agent.id, workspaceId, TEACH_FILE_TYPE, `${base}/${path}`, data)

	try {
		await put('README.md', Buffer.from(buildReadme(recordingId, request), 'utf8'))
		await put('log.json', Buffer.from(buildActionLog(request), 'utf8'))
		for (const frame of decoded.frames) await put(frameFileName(frame.id), frame.data)
	} catch (err) {
		logger.error('teach recording upload failed', { workspaceId, error: String(err) })
		await deleteRecordings(storage, agent.id, workspaceId, (p) =>
			p.startsWith(`${TEACH_FILE_TYPE}/${base}/`),
		).catch(() => {})
		return c.json(createApiError('INTERNAL_ERROR', 'Could not store the recording'), 502)
	}

	let sessionId: string
	try {
		const session = await c.get('sessionManager').createSession(workspaceId, {
			actorId: agent.id,
			actionPrompt: buildTeachPrompt({
				recordingId,
				description: request.description,
				agentId: agent.id,
				agentName: agent.name,
			}),
			createdBy: actorId,
			initiatedFromObjectId: null,
		})
		sessionId = session.id
	} catch (err) {
		logger.error('teach session start failed', { workspaceId, error: String(err) })
		await deleteRecordings(storage, agent.id, workspaceId, (p) =>
			p.startsWith(`${TEACH_FILE_TYPE}/${base}/`),
		).catch(() => {})
		return c.json(createApiError('INTERNAL_ERROR', 'Could not start the learning session'), 502)
	}

	// Last-resort expiry for a process that stays up; a restart falls back on the
	// sweep above. unref() so it never holds the process open.
	setTimeout(() => {
		void deleteRecordings(storage, agent.id, workspaceId, (p) =>
			p.startsWith(`${TEACH_FILE_TYPE}/${base}/`),
		).catch(() => {})
	}, TEACH_RETENTION_MS).unref()

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'workspace_desktop',
		entityId: workspaceId,
		// Counts only: never the description or the typed text.
		data: {
			teach: true,
			agent_id: agent.id,
			session_id: sessionId,
			frames: decoded.frames.length,
			events: request.events.length,
		},
	}).catch((err) => logger.warn('desktop teach event failed', { error: String(err) }))

	return c.json(
		{
			recording_id: recordingId,
			session_id: sessionId,
			agent_id: agent.id,
			frames_stored: decoded.frames.length,
			events_stored: request.events.length,
		},
		201,
	)
})

app.openapi(deleteRoute, async (c) => {
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const { recordingId } = c.req.valid('param')
	const { agent_id } = c.req.valid('query')
	const prefix = `${TEACH_FILE_TYPE}/${teachDir(recordingId)}/`
	const deleted = await deleteRecordings(c.get('agentStorage'), agent_id, workspaceId, (p) =>
		p.startsWith(prefix),
	)
	return c.json({ deleted }, 200)
})

export default app
