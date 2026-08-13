import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { z } from 'zod'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { AgentBuilderError, runAgentBuilder } from '../services/agent-builder'

// POST /api/agent-builder/create — thin HTTP wrapper around the
// agent-builder service. Stage 1 (intent) + stage 2 (persona) only in T2;
// stages 3-6 (SKILL.md, actor registration, gap report) land in T3/T4.

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const createBodySchema = z.object({
	prompt: z.string().min(1).max(4000),
	workspace_id: z.string().uuid().optional(),
	examples: z.array(z.string().min(1).max(2000)).max(10).optional(),
	references: z.array(z.string().min(1).max(2000)).max(10).optional(),
	constraints: z.array(z.string().min(1).max(2000)).max(10).optional(),
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

	try {
		const result = await runAgentBuilder({
			prompt: body.prompt,
			examples: body.examples,
			references: body.references,
			constraints: body.constraints,
		})

		if (result.kind === 'gap_question') {
			return c.json({ gap_question: result.gap_question, missing: result.missing }, 200)
		}

		return c.json({ intent: result.intent, persona: result.persona }, 200)
	} catch (err) {
		if (err instanceof AgentBuilderError) {
			logger.warn('agent-builder: pipeline error', {
				reason: err.reason,
				message: err.message,
			})
			const code = err.reason === 'llm_no_api_key' ? 'INTERNAL_ERROR' : 'INTERNAL_ERROR'
			return c.json(createApiError(code, err.message), 500)
		}
		throw err
	}
})

export default app
