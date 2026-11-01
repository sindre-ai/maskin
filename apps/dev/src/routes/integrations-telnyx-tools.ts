import { createHash, timingSafeEqual } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { readTelnyxRuntimeConfig } from '../lib/integrations/providers/telnyx/config'
import { dispatchToolInvocation } from '../lib/integrations/providers/telnyx/tool-dispatch'
import { logger } from '../lib/logger'

type Env = {
	Variables: {
		db: Database
	}
}

const app = new OpenAPIHono<Env>()

/** Constant-time compare. Both sides are hashed first so a length difference leaks nothing. */
function secretMatches(presented: string, expected: string): boolean {
	const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest()
	return timingSafeEqual(digest(presented), digest(expected))
}

function bearerOf(header: string | undefined): string | null {
	const m = /^Bearer (.+)$/.exec(header?.trim() ?? '')
	return m?.[1] ?? null
}

/** The contact whose current call this is: the reducer stamps last_call_id when the call starts. */
async function findContactByCallId(db: Database, callId: string) {
	const [row] = await db
		.select({ id: objects.id, workspaceId: objects.workspaceId })
		.from(objects)
		.where(and(eq(objects.type, 'contact'), sql`${objects.metadata}->>'last_call_id' = ${callId}`))
		.limit(1)
	return row ?? null
}

/**
 * Plain-POST tool endpoint. Telnyx assistant webhook tools post the model's arguments as a plain
 * JSON body, with no event envelope and no Ed25519 signature, so the signed webhook route cannot
 * receive them. The assistant config adds call_control_id to every body (preset field); the tool
 * name is the last path segment. Authenticated by a shared secret sent as a Bearer header.
 */
app.post('/:toolName', async (c) => {
	const secret = readTelnyxRuntimeConfig().toolWebhookSecret
	const presented = bearerOf(c.req.header('authorization'))
	// Fails closed: with no secret configured every request is rejected.
	if (!secret || !presented || !secretMatches(presented, secret)) {
		logger.warn('telnyx tool request rejected', { reason: secret ? 'bad_secret' : 'no_secret' })
		return c.json(createApiError('UNAUTHORIZED', 'Invalid tool credentials'), 401)
	}

	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Body is not valid JSON'), 400)
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json(createApiError('BAD_REQUEST', 'Body must be a JSON object'), 400)
	}
	const { call_control_id: callId, ...toolInput } = body as Record<string, unknown>
	if (typeof callId !== 'string' || callId === '') {
		return c.json(createApiError('BAD_REQUEST', 'call_control_id is required'), 400)
	}

	const db = c.get('db')
	const toolName = c.req.param('toolName')
	try {
		const contact = await findContactByCallId(db, callId)
		if (!contact) return c.json({ error: 'call_not_current' })
		return c.json(
			await dispatchToolInvocation({
				db,
				callId,
				toolName,
				toolInput,
				clientState: { contact_id: contact.id, workspace_id: contact.workspaceId },
			}),
		)
	} catch (err) {
		logger.error('telnyx tool request failed', {
			toolName,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Tool handler failed'), 500)
	}
})

export default app
