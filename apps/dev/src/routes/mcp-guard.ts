import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { blockedToolCalls, extensions, sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { ApiErrorCode, createApiError, validationFailureHook } from '../lib/errors'
import { guardKeyExpired, guardKeyMatches, parseGuardKey } from '../lib/integrations/mcp-guard'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { TERMINAL_STATUSES } from '../services/session-lifecycle'

type Env = {
	Variables: {
		db: Database
	}
}

// Passed explicitly: a mounted sub-app does not inherit the parent's hook.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const reportBodySchema = z.object({
	tool_name: z.string().min(1).max(256),
	// Accepted only so a mismatch can be refused. The session always comes from the key.
	session_id: z.string().uuid().optional(),
})

const reportRoute = createRoute({
	method: 'post',
	path: '/report',
	tags: ['Internal'],
	summary: 'Record a tool call the guard wrapper refused',
	description:
		'Called by maskin-mcp-guard inside an agent container. Authentication: `Authorization: Bearer <session key>`. The key is bound to one session and one extension, minted at launch. Session and extension come from the key, never from the body. A key stays valid for 60 seconds after its session ends.',
	request: {
		body: { content: { 'application/json': { schema: reportBodySchema } } },
	},
	responses: {
		200: {
			description: 'Denial recorded',
			content: { 'application/json': { schema: z.object({ recorded: z.literal(true) }) } },
		},
		400: {
			description: 'Invalid request body',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Key is missing, unknown, expired, or names another session',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(reportRoute, async (c) => {
	const forbidden = (reason: string) => {
		logger.warn('MCP guard report rejected', { reason })
		return c.json(createApiError(ApiErrorCode.FORBIDDEN, 'Invalid session key'), 403)
	}

	const header = c.req.header('Authorization') ?? ''
	const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
	const ids = key ? parseGuardKey(key) : null
	if (!ids) return forbidden(key ? 'malformed_key' : 'missing_key')

	const body = c.req.valid('json')
	if (body.session_id && body.session_id !== ids.sessionId) return forbidden('session_mismatch')

	const db = c.get('db')
	const [session] = await db
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			status: sessions.status,
			completedAt: sessions.completedAt,
			updatedAt: sessions.updatedAt,
			config: sessions.config,
		})
		.from(sessions)
		.where(eq(sessions.id, ids.sessionId))
		.limit(1)
	if (!session) return forbidden('unknown_session')

	const guardKeys = (session.config as { guard_keys?: Record<string, string> } | null)?.guard_keys
	if (!guardKeyMatches(key, guardKeys?.[ids.extensionId])) return forbidden('wrong_key')
	if (guardKeyExpired(session, TERMINAL_STATUSES)) return forbidden('expired_key')

	const [extension] = await db
		.select({ id: extensions.id })
		.from(extensions)
		.where(and(eq(extensions.id, ids.extensionId), eq(extensions.workspaceId, session.workspaceId)))
		.limit(1)
	if (!extension) return forbidden('unknown_extension')

	await db.insert(blockedToolCalls).values({
		workspaceId: session.workspaceId,
		extensionId: extension.id,
		agentId: session.actorId,
		toolName: body.tool_name,
		sessionId: session.id,
	})
	return c.json({ recorded: true as const }, 200)
})

export default app
