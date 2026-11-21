import type { Database } from '@maskin/db'
import { isPilotHeldIntegrationTool } from '@maskin/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { createApiError } from '../lib/errors'
import { classifyTool } from '../lib/integrations/tool-kinds'
import { checkPilotHold } from '../lib/pilot-hold'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType?: string
		maskinSessionId?: string
	}
}

const app = new Hono<Env>()

const checkSchema = z.object({
	tool: z.string().min(1).max(200),
	arguments: z.unknown().optional(),
	/**
	 * Set by a caller that runs an outside integration's tool itself (the GitHub relay in the agent
	 * container). Maskin then decides whether that tool is outbound. Left out by the Maskin MCP
	 * server, which only asks about a tool that is already on the outbound list.
	 */
	provider: z.string().min(1).max(100).optional(),
})

/**
 * POST /api/pilot-gate/check
 *
 * Asks whether the calling agent's session may run one outbound call now. Held means the caller
 * refuses it with `message` and does nothing; a card is on its way to a person. Allowed means it
 * runs, and when it was held before and a person approved that exact call, the approval is spent
 * by this answer, so a caller asks once per call and acts on the answer.
 *
 * Only for agents with a session: a person, or a call with no session header, is never held.
 */
app.post('/check', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	const parsed = checkSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(createApiError('BAD_REQUEST', 'Send a tool name and its arguments.'), 400)
	}
	const sessionId = c.get('maskinSessionId')
	if (c.get('actorType') !== 'agent' || !sessionId) return c.json({ held: false })

	const { tool, provider } = parsed.data
	if (provider && !isPilotHeldIntegrationTool(provider, classifyTool(provider, tool))) {
		return c.json({ held: false })
	}
	const result = await checkPilotHold(db, {
		workspaceId,
		agentId: c.get('actorId'),
		sessionId,
		tool: provider ? `${provider}__${tool}` : tool,
		args: parsed.data.arguments,
	})
	return c.json(result)
})

export default app
