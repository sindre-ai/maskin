import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { z } from 'zod'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { AgentBuilderError, runAgentBuilder } from '../services/agent-builder'
import type { AgentStorageManager } from '../services/agent-storage'

// POST /api/agent-builder/create — thin HTTP wrapper around the
// agent-builder service. Runs the full pipeline (stages 1-4 + actor +
// SKILL.md registration). Underspecified prompts short-circuit at stage 1
// and return { gap_question, missing } without touching the workspace.

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

	// Resolve workspace from the header (set by the MCP tool) or the body.
	// Required for the persona path because actor registration writes into the
	// workspace's actor + skill tables. The gap_question path returns before
	// we touch the workspace, so a missing id there is not fatal — but we
	// require it up front to keep the contract simple.
	const headerWorkspaceId = c.req.header('X-Workspace-Id') ?? c.req.header('x-workspace-id')
	const workspaceId = body.workspace_id ?? headerWorkspaceId
	if (!workspaceId || !UUID_RE.test(workspaceId)) {
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

	try {
		const result = await runAgentBuilder(
			{
				prompt: body.prompt,
				examples: body.examples,
				references: body.references,
				constraints: body.constraints,
			},
			{ db, agentStorage, workspaceId, actorId },
		)

		if (result.kind === 'gap_question') {
			return c.json({ gap_question: result.gap_question, missing: result.missing }, 200)
		}

		return c.json(
			{
				actor_id: result.actor.id,
				actor_name: result.actor.name,
				skill_id: result.skill.id,
				skill_name: result.skill.name,
				intent: result.intent,
				persona: result.persona,
				system_prompt: result.assembledSystemPrompt,
				definition_summary: result.definitionSummary,
				gap_report: result.gapReportMarkdown,
				gap_report_items: result.gapReport.gap_items,
				gap_report_comment_posted: result.gapReportCommentPosted,
			},
			200,
		)
	} catch (err) {
		if (err instanceof AgentBuilderError) {
			logger.warn('agent-builder: pipeline error', {
				reason: err.reason,
				message: err.message,
			})
			return c.json(createApiError('INTERNAL_ERROR', err.message), 500)
		}
		throw err
	}
})

export default app
