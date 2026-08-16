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
	reviewerVerdictWorkflow,
} from '../services/agent-builder'
import {
	buildAgentBuilderActionPrompt,
	getOrBootstrapAgentBuilderActor,
} from '../services/agent-builder-bootstrap'
import { AgentReviewerError } from '../services/agent-reviewer'
import type { AgentStorageManager } from '../services/agent-storage'
import { ReviewerVerdictError } from '../services/reviewer-verdicts'
import type { SessionManager } from '../services/session-manager'

// POST /api/agent-builder/create — bootstraps (or reuses) the per-workspace
// "Agent Builder" actor and kicks off one async container session that does
// intent extraction, persona synthesis, system-prompt authoring, self-
// critique, and actor/skill registration itself. Returns { session_id,
// status } immediately — the caller polls get_session for the eventual
// result (JSON in session.result.final_message).
// POST /api/agent-builder/reviewer-verdict — fresh-context review against a
// workspace object or a terminal session's result, optional human/agent
// rating of a verdict, and the rubric's precision summary — whichever of the
// three the request has enough fields to run (see reviewerVerdictWorkflow's
// doc comment for exactly what triggers what).
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

const reviewerVerdictBodySchema = z
	.object({
		object_id: z.string().uuid().optional(),
		session_id: z.string().uuid().optional(),
		target_actor_id: z.string().uuid().optional(),
		rubric_id: z.string().uuid().optional(),
		verdict_id: z.string().uuid().optional(),
		human_agreed: z.boolean().optional(),
		criteria_disagreements: z.array(z.string().min(1).max(200)).max(20).optional(),
		note: z.string().max(2000).optional(),
		workspace_id: z.string().uuid().optional(),
	})
	.refine((v) => !(v.object_id && v.session_id), {
		message: 'Provide at most one of object_id or session_id.',
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

app.post('/reviewer-verdict', async (c) => {
	let body: z.infer<typeof reviewerVerdictBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = reviewerVerdictBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { object_id?, session_id?: uuid (at most one), target_actor_id?, rubric_id?, ' +
						'verdict_id?: uuid, human_agreed?: boolean, criteria_disagreements?: string[], note?: string, ' +
						'workspace_id?: uuid }',
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
		const { review, rating, precisionSummary } = await reviewerVerdictWorkflow(db, {
			workspaceId,
			actorId,
			objectId: body.object_id,
			sessionId: body.session_id,
			targetActorId: body.target_actor_id,
			rubricId: body.rubric_id,
			verdictId: body.verdict_id,
			humanAgreed: body.human_agreed,
			criteriaDisagreements: body.criteria_disagreements,
			note: body.note,
		})
		return c.json(
			{
				verdict: review
					? {
							criteria: review.verdict.criteria,
							overall: review.verdict.overall,
							verdict_id: review.verdictId,
							persisted: review.persisted,
							persistence_note: review.persistenceNote,
							reviewer_session_id: review.reviewerSessionId,
							rubric_id: review.rubricId,
							target_actor_id: review.targetActorId,
						}
					: null,
				rating: rating
					? {
							verdict_id: rating.verdictId,
							human_agreed: rating.humanAgreed,
							human_criteria_disagreements: rating.humanCriteriaDisagreements,
						}
					: null,
				precision_summary: precisionSummary,
			},
			200,
		)
	} catch (err) {
		if (err instanceof AgentReviewTargetError) {
			const status =
				err.reason === 'target_not_found' || err.reason === 'rubric_not_found' ? 404 : 400
			return c.json(createApiError('VALIDATION_ERROR', err.message), status)
		}
		if (err instanceof ReviewerVerdictError) {
			// Mirrors routes/reviewer-verdicts.ts's mapErrorCode — same
			// ReviewerVerdictError codes must map to the same HTTP status
			// regardless of which route surfaces them.
			if (
				err.code === 'verdict_not_found' ||
				err.code === 'target_actor_not_found' ||
				err.code === 'rubric_not_found'
			) {
				return c.json(createApiError('NOT_FOUND', err.message), 404)
			}
			if (err.code === 'already_rated') {
				return c.json(createApiError('CONFLICT', err.message), 409)
			}
			if (err.code === 'self_rating_forbidden') {
				return c.json(createApiError('FORBIDDEN', err.message), 403)
			}
			return c.json(createApiError('VALIDATION_ERROR', err.message), 400)
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
