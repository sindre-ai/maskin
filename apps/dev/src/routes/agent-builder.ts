import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { z } from 'zod'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	AgentBuilderError,
	AgentRefineError,
	AgentReviewTargetError,
	refineAgent,
	reviewWork,
} from '../services/agent-builder'
import {
	buildAgentBuilderActionPrompt,
	getOrBootstrapAgentBuilderActor,
} from '../services/agent-builder-bootstrap'
import { AgentReviewerError } from '../services/agent-reviewer'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

// POST /api/agent-builder/create — bootstraps (or reuses) the per-workspace
// "Agent Builder" actor and kicks off one async container session that does
// intent extraction, persona synthesis, system-prompt authoring, self-
// critique, and actor/skill registration itself. Returns { session_id,
// status } immediately — the caller polls get_session for the eventual
// result (JSON in session.result.final_message).
// POST /api/agent-builder/review — standalone reviewer against a workspace
// object or a terminal session's result.
// POST /api/agent-builder/refine — re-run stages 3-4 for an existing actor
// with a free-text refinement instruction and republish the SKILL.md.

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
		sessionManager: SessionManager
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function resolveWorkspaceId(
	c: {
		req: { header: (name: string) => string | undefined }
	},
	bodyValue: string | undefined,
): string | null {
	const headerWorkspaceId = c.req.header('X-Workspace-Id') ?? c.req.header('x-workspace-id')
	const workspaceId = bodyValue ?? headerWorkspaceId
	if (!workspaceId || !UUID_RE.test(workspaceId)) return null
	return workspaceId
}

const createBodySchema = z.object({
	prompt: z.string().min(1).max(4000),
	workspace_id: z.string().uuid().optional(),
	examples: z.array(z.string().min(1).max(2000)).max(10).optional(),
	references: z.array(z.string().min(1).max(2000)).max(10).optional(),
	constraints: z.array(z.string().min(1).max(2000)).max(10).optional(),
})

const reviewBodySchema = z
	.object({
		object_id: z.string().uuid().optional(),
		session_id: z.string().uuid().optional(),
		rubric_id: z.string().uuid().optional(),
		workspace_id: z.string().uuid().optional(),
	})
	.refine((v) => Boolean(v.object_id) !== Boolean(v.session_id), {
		message: 'Provide exactly one of object_id or session_id.',
	})

const refineBodySchema = z.object({
	actor_id: z.string().uuid(),
	context: z.string().min(1).max(4000),
	workspace_id: z.string().uuid().optional(),
})

const app = new OpenAPIHono<Env>()

app.post('/create', async (c) => {
	let body: z.infer<typeof createBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = createBodySchema.safeParse(raw)
		if (!parsed.success) {
			logger.warn('agent-builder: request validation failed', {
				path: c.req.path,
				method: c.req.method,
				details: formatZodError(parsed.error),
			})
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { prompt: string (1-4000), workspace_id?: uuid, examples?/references?/constraints?: string[] }',
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	const workspaceId = resolveWorkspaceId(c, body.workspace_id)
	if (!workspaceId) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'workspace_id is required (as body field or X-Workspace-Id header, valid UUID)',
			),
			400,
		)
	}

	const db = c.get('db')
	const actorId = c.get('actorId')
	const agentStorage = c.get('agentStorage')
	const sessionManager = c.get('sessionManager')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	try {
		const { actorId: builderActorId } = await getOrBootstrapAgentBuilderActor(
			db,
			agentStorage,
			workspaceId,
			actorId,
		)

		const actionPrompt = buildAgentBuilderActionPrompt({
			prompt: body.prompt,
			workspaceId,
			examples: body.examples,
			references: body.references,
			constraints: body.constraints,
		})

		const session = await sessionManager.createSession(workspaceId, {
			actorId: builderActorId,
			actionPrompt,
			createdBy: actorId,
			autoStart: true,
		})

		return c.json({ session_id: session.id, status: session.status }, 202)
	} catch (err) {
		logger.error('agent-builder: failed to start create session', {
			workspaceId,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to start agent-builder session'), 500)
	}
})

app.post('/review', async (c) => {
	let body: z.infer<typeof reviewBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = reviewBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { object_id | session_id (exactly one), rubric_id?: uuid, workspace_id?: uuid }',
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	const workspaceId = resolveWorkspaceId(c, body.workspace_id)
	if (!workspaceId) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'workspace_id is required (as body field or X-Workspace-Id header, valid UUID)',
			),
			400,
		)
	}

	const db = c.get('db')
	const actorId = c.get('actorId')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	try {
		const { verdict, reviewerSessionId, rubricId, targetActorId } = await reviewWork(db, {
			workspaceId,
			actorId,
			objectId: body.object_id,
			sessionId: body.session_id,
			rubricId: body.rubric_id,
		})
		return c.json(
			{
				criteria: verdict.criteria,
				overall: verdict.overall,
				reviewer_session_id: reviewerSessionId,
				rubric_id: rubricId,
				target_actor_id: targetActorId,
			},
			200,
		)
	} catch (err) {
		if (err instanceof AgentReviewTargetError) {
			const status =
				err.reason === 'target_not_found' || err.reason === 'rubric_not_found' ? 404 : 400
			return c.json(createApiError('VALIDATION_ERROR', err.message), status)
		}
		if (err instanceof AgentReviewerError) {
			logger.warn('agent-builder: reviewer error', { reason: err.reason, message: err.message })
			return c.json(createApiError('INTERNAL_ERROR', err.message), 500)
		}
		throw err
	}
})

app.post('/refine', async (c) => {
	let body: z.infer<typeof refineBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = refineBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { actor_id: uuid, context: string (1-4000), workspace_id?: uuid }',
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	const workspaceId = resolveWorkspaceId(c, body.workspace_id)
	if (!workspaceId) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'workspace_id is required (as body field or X-Workspace-Id header, valid UUID)',
			),
			400,
		)
	}

	const db = c.get('db')
	const actorId = c.get('actorId')
	const agentStorage = c.get('agentStorage')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	try {
		const result = await refineAgent(
			{ db, agentStorage, workspaceId, actorId },
			{ actorId: body.actor_id, context: body.context },
		)
		return c.json(
			{
				updated_actor_id: result.updatedActorId,
				diff: result.diff,
				new_system_prompt: result.newSystemPrompt,
			},
			200,
		)
	} catch (err) {
		if (err instanceof AgentRefineError) {
			const status =
				err.reason === 'skill_not_found' || err.reason === 'actor_wrong_workspace' ? 404 : 400
			return c.json(createApiError('VALIDATION_ERROR', err.message), status)
		}
		if (err instanceof AgentBuilderError) {
			logger.warn('agent-builder: refine pipeline error', {
				reason: err.reason,
				message: err.message,
			})
			return c.json(createApiError('INTERNAL_ERROR', err.message), 500)
		}
		throw err
	}
})

export default app
