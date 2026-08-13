import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { z } from 'zod'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { runAgentBuilder } from '../services/agent-builder'

// POST /api/agent-builder/create — runs the maskin_create_agent pipeline
// stages 1 and 2. Underspecified prompts return early with a gap_question so
// the caller can re-prompt the human rather than materialising a hallucinated
// persona. T3 will layer on stages 3-5 (system prompt + opinionation +
// SKILL.md + actor registration) inside the same service module.

type Env = {
	Variables: {
		db: Database
	}
}

const createBodySchema = z.object({
	prompt: z.string().min(1).max(4000),
	workspace_id: z.string().uuid().optional(),
	examples: z.array(z.string().min(1).max(500)).max(20).optional(),
	references: z.array(z.string().min(1).max(500)).max(20).optional(),
	constraints: z.array(z.string().min(1).max(500)).max(20).optional(),
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
				details: formatZodError(parsed.error),
			})
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { prompt: string (1-4000 chars), workspace_id?: uuid, examples?: string[], references?: string[], constraints?: string[] }',
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	const result = await runAgentBuilder({
		prompt: body.prompt,
		examples: body.examples,
		references: body.references,
		constraints: body.constraints,
	})

	if (result.status === 'error') {
		if (result.reason === 'llm_unavailable') {
			logger.warn('agent-builder: LLM provider not configured')
			return c.json(createApiError('INTERNAL_ERROR', result.message), 503)
		}
		logger.error('agent-builder: pipeline error', {
			reason: result.reason,
			message: result.message,
		})
		return c.json(createApiError('INTERNAL_ERROR', result.message), 500)
	}

	if (result.status === 'underspecified') {
		return c.json(
			{
				status: 'underspecified' as const,
				gap_question: result.gap_question,
				intent: result.intent,
			},
			200,
		)
	}

	return c.json(
		{
			status: 'ok' as const,
			intent: result.intent,
			persona: result.persona,
		},
		200,
	)
})

app.onError((err, c) => {
	logger.error('agent-builder: unhandled error', {
		err: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
})

export default app
