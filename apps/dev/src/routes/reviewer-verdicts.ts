import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { z } from 'zod'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	ReviewerVerdictError,
	computeReviewerPrecision,
	rateReviewerVerdict,
	recordReviewerVerdict,
} from '../services/reviewer-verdicts'

// REST surface for T7 — reviewer precision rating mechanism.
//   POST   /api/reviewer-verdicts         → persist a reviewer verdict (called by T6's reviewer)
//   PATCH  /api/reviewer-verdicts/:id     → human/agent sets `human_agreed`
//   GET    /api/reviewer-verdicts/summary → precision + failing-criteria per rubric

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const criterionVerdictSchema = z.object({
	name: z.string().min(1).max(200),
	pass: z.boolean(),
	fix: z.string().max(2000).nullable().optional(),
})

const recordBodySchema = z.object({
	rubric_id: z.string().uuid(),
	actor_id: z.string().uuid(),
	reviewer_actor_id: z.string().uuid(),
	reviewer_session_id: z.string().uuid().optional(),
	cycle_number: z.number().int().min(0).max(10).optional(),
	verdict: z.enum(['pass', 'fail']),
	criteria_verdicts: z.array(criterionVerdictSchema).min(1).max(20),
})

const rateBodySchema = z.object({
	human_agreed: z.boolean(),
	criteria_disagreements: z.array(z.string().min(1).max(200)).max(20).optional(),
	note: z.string().max(2000).optional(),
})

const idParamSchema = z.object({ id: z.string().uuid() })

const summaryQuerySchema = z.object({
	rubric_id: z.string().uuid(),
})

const app = new OpenAPIHono<Env>()

function requireWorkspaceId(headerValue: string | undefined): string | null {
	if (!headerValue) return null
	const uuid = z.string().uuid().safeParse(headerValue)
	return uuid.success ? uuid.data : null
}

function mapErrorCode(err: ReviewerVerdictError): {
	status: 400 | 403 | 404 | 409
	code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'FORBIDDEN'
} {
	switch (err.code) {
		case 'rubric_not_found':
		case 'target_actor_not_found':
		case 'verdict_not_found':
			return { status: 404, code: 'NOT_FOUND' }
		case 'already_rated':
			return { status: 409, code: 'CONFLICT' }
		case 'self_rating_forbidden':
			return { status: 403, code: 'FORBIDDEN' }
	}
}

app.post('/', async (c) => {
	const workspaceId = requireWorkspaceId(c.req.header('X-Workspace-Id'))
	if (!workspaceId) {
		return c.json(createApiError('VALIDATION_ERROR', 'X-Workspace-Id header required (uuid)'), 400)
	}
	const actorId = c.get('actorId')
	const db = c.get('db')

	let body: z.infer<typeof recordBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = recordBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError('VALIDATION_ERROR', 'Invalid body', formatZodError(parsed.error)),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	try {
		const { id } = await recordReviewerVerdict({
			db,
			workspaceId,
			rubricId: body.rubric_id,
			targetActorId: body.actor_id,
			reviewerActorId: body.reviewer_actor_id,
			reviewerSessionId: body.reviewer_session_id ?? null,
			cycleNumber: body.cycle_number ?? 0,
			verdict: body.verdict,
			criteriaVerdicts: body.criteria_verdicts,
			createdBy: actorId,
		})
		return c.json({ id, human_agreed: null }, 201)
	} catch (err) {
		if (err instanceof ReviewerVerdictError) {
			const { status, code } = mapErrorCode(err)
			return c.json(createApiError(code, err.message), status)
		}
		logger.error('reviewer-verdicts: create failed', { error: String(err) })
		throw err
	}
})

app.patch('/:id', async (c) => {
	const workspaceId = requireWorkspaceId(c.req.header('X-Workspace-Id'))
	if (!workspaceId) {
		return c.json(createApiError('VALIDATION_ERROR', 'X-Workspace-Id header required (uuid)'), 400)
	}
	const actorId = c.get('actorId')
	const db = c.get('db')

	const paramParsed = idParamSchema.safeParse({ id: c.req.param('id') })
	if (!paramParsed.success) {
		return c.json(createApiError('VALIDATION_ERROR', 'id must be a uuid'), 400)
	}

	let body: z.infer<typeof rateBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = rateBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError('VALIDATION_ERROR', 'Invalid body', formatZodError(parsed.error)),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	try {
		const result = await rateReviewerVerdict({
			db,
			workspaceId,
			verdictId: paramParsed.data.id,
			ratedByActorId: actorId,
			humanAgreed: body.human_agreed,
			criteriaDisagreements: body.criteria_disagreements,
			note: body.note,
		})
		return c.json({
			id: result.id,
			human_agreed: result.humanAgreed,
			human_criteria_disagreements: result.humanCriteriaDisagreements,
		})
	} catch (err) {
		if (err instanceof ReviewerVerdictError) {
			const { status, code } = mapErrorCode(err)
			return c.json(createApiError(code, err.message), status)
		}
		logger.error('reviewer-verdicts: rate failed', { error: String(err) })
		throw err
	}
})

app.get('/summary', async (c) => {
	const workspaceId = requireWorkspaceId(c.req.header('X-Workspace-Id'))
	if (!workspaceId) {
		return c.json(createApiError('VALIDATION_ERROR', 'X-Workspace-Id header required (uuid)'), 400)
	}
	const db = c.get('db')
	const parsed = summaryQuerySchema.safeParse({ rubric_id: c.req.query('rubric_id') })
	if (!parsed.success) {
		return c.json(createApiError('VALIDATION_ERROR', 'Query must be { rubric_id: uuid }'), 400)
	}
	const summary = await computeReviewerPrecision({
		db,
		workspaceId,
		rubricId: parsed.data.rubric_id,
	})
	return c.json(summary)
})

export default app
