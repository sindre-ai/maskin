import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { credentialAccessLog, integrations } from '@maskin/db/schema'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	CHAT_CAPTURE_PROVIDERS,
	ChatCaptureError,
	captureChatSecret,
} from '../lib/integrations/chat-capture'
import { insertCredentialAccessLog } from '../lib/integrations/credential-audit'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

// Keychain routes that sit next to /api/integrations. A separate file so the
// 3.6k-line integrations router stays untouched; mounted on the same prefix.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ── POST /api/integrations/chat-capture ──────────────────────────────────

const scopeGrantSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('actor'), actorId: z.string().uuid() }).strict(),
	z.object({ kind: z.literal('workspace') }).strict(),
])

const chatCaptureBodySchema = z
	.object({
		sessionId: z.string().uuid(),
		providerMode: z.literal('byo_apikey'),
		detectedProvider: z.enum(CHAT_CAPTURE_PROVIDERS as [string, ...string[]]),
		displayName: z.string().trim().min(1).max(80),
		rawSecret: z.string().min(1).max(4096),
		scopeGrants: z.array(scopeGrantSchema).max(25).optional(),
	})
	.strict()

const chatCaptureResponseSchema = z.object({
	integrationId: z.string().uuid(),
	undoExpiresAt: z.string(),
	undoUrl: z.string(),
	// Stub: PR #4 replaces it with the real stop-and-respawn relaunch.
	relaunch: z.literal('stopped'),
})

// No `request.body` on purpose. The request validator would parse the body into
// strings we can never clear; the handler reads the raw buffer itself so it can
// zero it once the secret is parsed. The schema above still guards the shape.
const chatCaptureRoute = createRoute({
	method: 'post',
	path: '/chat-capture',
	tags: ['integrations'],
	summary: 'Vault a secret pasted in chat (humans only)',
	request: { headers: workspaceIdHeader },
	responses: {
		201: {
			description: 'Captured; undoable until undoExpiresAt',
			content: { 'application/json': { schema: chatCaptureResponseSchema } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not a human', content: { 'application/json': { schema: errorSchema } } },
		404: {
			description: 'Session not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(chatCaptureRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Agents never vault secrets: an agent that held one has already seen it.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can vault a key from chat'), 403)
	}

	// Own the bytes so they can be cleared. Hono caches this same ArrayBuffer, so
	// zeroing the view clears the cached copy as well. The decoded string below is
	// a JavaScript string and cannot be cleared; it is kept as short-lived as
	// possible and is never logged or placed on an error.
	const raw = Buffer.from(await c.req.arrayBuffer())
	let parsed: z.SafeParseReturnType<unknown, z.infer<typeof chatCaptureBodySchema>>
	try {
		parsed = chatCaptureBodySchema.safeParse(JSON.parse(raw.toString('utf8')))
	} catch {
		raw.fill(0)
		return c.json(createApiError('BAD_REQUEST', 'Body must be valid JSON'), 400)
	}
	raw.fill(0)
	if (!parsed.success) {
		// Field paths only. Zod issues for a bad rawSecret could echo the value.
		const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))]
		return c.json(createApiError('BAD_REQUEST', `Invalid fields: ${fields.join(', ')}`), 400)
	}
	const body = parsed.data

	try {
		const result = await captureChatSecret(db, getKmsProvider(db), {
			workspaceId,
			actorId,
			sessionId: body.sessionId,
			detectedProvider: body.detectedProvider as (typeof CHAT_CAPTURE_PROVIDERS)[number],
			displayName: body.displayName,
			scopeGrants: body.scopeGrants,
			rawSecret: body.rawSecret,
		})

		void capturePosthogEvent('keychain_credential_created', actorId, {
			workspace_id: workspaceId,
			integration_id: result.integrationId,
			provider: body.detectedProvider,
			provider_mode: 'byo_apikey',
			source: 'chat_capture',
		})

		return c.json(
			{
				integrationId: result.integrationId,
				undoExpiresAt: result.undoExpiresAt.toISOString(),
				undoUrl: `/api/integrations/${result.integrationId}/undo`,
				relaunch: 'stopped' as const,
			},
			201,
		)
	} catch (err) {
		if (err instanceof ChatCaptureError) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		// Error text only, never the request: a driver error can carry bound params.
		logger.error('Chat capture failed', {
			workspaceId,
			sessionId: body.sessionId,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
}) as RouteHandler<typeof chatCaptureRoute, Env>)

// ── POST /api/integrations/:id/undo ──────────────────────────────────────

const undoRoute = createRoute({
	method: 'post',
	path: '/{id}/undo',
	tags: ['integrations'],
	summary: 'Undo a chat capture inside its 5 minute window',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Undone: the secret is zeroised, the row is kept for the audit chain',
			content: {
				'application/json': {
					schema: z.object({ id: z.string().uuid(), status: z.literal('undone') }),
				},
			},
		},
		403: {
			description: 'Not the person who captured it, or another workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'Window closed, or not pending undo (already undone)',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(undoRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const [row] = await db
		.select({
			workspaceId: integrations.workspaceId,
			createdBy: integrations.createdBy,
			createdAt: integrations.createdAt,
			provider: integrations.provider,
			source: integrations.source,
			originSessionId: integrations.originSessionId,
		})
		.from(integrations)
		.where(eq(integrations.id, id))
		.limit(1)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)
	// Looked up by id alone, so the workspace check is explicit: a caller in another
	// workspace learns nothing beyond "not yours".
	if (row.workspaceId !== workspaceId || row.createdBy !== callerId) {
		return c.json(
			createApiError('FORBIDDEN', 'Only the person who captured this key can undo it'),
			403,
		)
	}

	// One conditional UPDATE decides the winner. The window is judged by the database
	// clock in the same statement, so two concurrent undos cannot both match: the
	// second re-reads the row after the first commits and finds it undone.
	const undone = await db.transaction(async (tx) => {
		const updated = await tx
			.update(integrations)
			.set({
				status: 'undone',
				credentials: null,
				dekCiphertext: null,
				undoExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(integrations.id, id),
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.status, 'pending_undo'),
					sql`${integrations.undoExpiresAt} > now()`,
				),
			)
			.returning({ id: integrations.id })
		if (updated.length === 0) return false

		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId: id,
			actorId: callerId,
			sessionId: row.originSessionId,
			action: 'undone',
			source: row.source,
			requestId: `undo:${id}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: { status: 'undone', provider: row.provider, source: row.source },
		})
		return true
	})
	if (!undone) {
		return c.json(
			createApiError('CONFLICT', 'The undo window has closed or this key is already undone'),
			409,
		)
	}

	void capturePosthogEvent('keychain_credential_undone', callerId, {
		workspace_id: workspaceId,
		integration_id: id,
		provider: row.provider,
		seconds_since_create: row.createdAt
			? Math.max(0, Math.round((Date.now() - row.createdAt.getTime()) / 1000))
			: null,
	})
	return c.json({ id, status: 'undone' as const }, 200)
}) as RouteHandler<typeof undoRoute, Env>)

// ── GET /api/integrations/:id/audit-log ──────────────────────────────────

const auditLogQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	before_id: z.string().regex(/^\d+$/).optional(),
})

const auditLogResponseSchema = z.object({
	integrationId: z.string().uuid(),
	source: z.string(),
	originSessionId: z.string().uuid().nullable(),
	entries: z.array(
		z.object({
			id: z.string(),
			actorId: z.string().uuid(),
			sessionId: z.string().uuid().nullable(),
			outboundTarget: z.string().nullable(),
			action: z.string(),
			source: z.string(),
			readAt: z.string(),
		}),
	),
	nextBeforeId: z.string().nullable(),
})

const auditLogRoute = createRoute({
	method: 'get',
	path: '/{id}/audit-log',
	tags: ['integrations'],
	summary: 'Audit log for one stored credential, newest first',
	request: { headers: workspaceIdHeader, params: idParamSchema, query: auditLogQuerySchema },
	responses: {
		200: {
			description: 'Audit rows',
			content: { 'application/json': { schema: auditLogResponseSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(auditLogRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { limit, before_id } = c.req.valid('query')

	const [integration] = await db
		.select({
			id: integrations.id,
			source: integrations.source,
			originSessionId: integrations.originSessionId,
		})
		.from(integrations)
		.where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!integration) return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)

	const conditions = [
		eq(credentialAccessLog.integrationId, id),
		eq(credentialAccessLog.workspaceId, workspaceId),
	]
	if (before_id) conditions.push(lt(credentialAccessLog.id, BigInt(before_id)))
	const rows = await db
		.select({
			id: credentialAccessLog.id,
			actorId: credentialAccessLog.actorId,
			sessionId: credentialAccessLog.sessionId,
			outboundTarget: credentialAccessLog.outboundTarget,
			action: credentialAccessLog.action,
			source: credentialAccessLog.source,
			readAt: credentialAccessLog.readAt,
		})
		.from(credentialAccessLog)
		.where(and(...conditions))
		.orderBy(desc(credentialAccessLog.id))
		.limit(limit + 1)

	const page = rows.slice(0, limit)
	const last = page[page.length - 1]
	return c.json({
		integrationId: integration.id,
		source: integration.source,
		originSessionId: integration.originSessionId,
		entries: page.map((r) => ({
			id: r.id.toString(),
			actorId: r.actorId,
			sessionId: r.sessionId,
			outboundTarget: r.outboundTarget,
			action: r.action,
			source: r.source,
			readAt: r.readAt.toISOString(),
		})),
		nextBeforeId: rows.length > limit && last ? last.id.toString() : null,
	})
}) as RouteHandler<typeof auditLogRoute, Env>)

export default app
