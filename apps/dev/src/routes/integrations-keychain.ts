import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { credentialAccessLog, integrations } from '@maskin/db/schema'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { BYO_APIKEY_PROVIDER, createByoApiKey } from '../lib/integrations/byo-apikey'
import { BYO_LOGIN_PROVIDER, createByoLogin } from '../lib/integrations/byo-login'
import {
	CHAT_CAPTURE_PROVIDERS,
	ChatCaptureError,
	captureChatSecret,
} from '../lib/integrations/chat-capture'
import { insertCredentialAccessLog } from '../lib/integrations/credential-audit'
import { CredentialNameError } from '../lib/integrations/credential-name'
import { updateCredential } from '../lib/integrations/credential-update'
import { CredentialValueError } from '../lib/integrations/credential-value'
import {
	LOGIN_PASSWORD_MAX_LENGTH,
	LOGIN_USERNAME_MAX_LENGTH,
	LoginValueError,
} from '../lib/integrations/login-value'
import { rotateIntegrationDek } from '../lib/integrations/rotate-dek'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'
import { endSessionHoldingKey, relaunchChatSession } from '../services/chat-relaunch'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
		sessionManager: SessionManager
	}
}

// Keychain routes that sit next to /api/integrations. A separate file so the
// 3.6k-line integrations router stays untouched; mounted on the same prefix.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/**
 * Reads a JSON body that carries a secret. Owns the bytes so they can be cleared:
 * Hono caches this same ArrayBuffer, so zeroing the view clears the cached copy
 * as well. The decoded string is a JavaScript string and cannot be cleared; it is
 * kept as short-lived as possible and is never logged or placed on an error.
 * On failure the message names fields only, never a value.
 */
async function readSecretBody<S extends z.ZodTypeAny>(
	c: Context<Env>,
	schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; message: string }> {
	const raw = Buffer.from(await c.req.arrayBuffer())
	let parsed: z.SafeParseReturnType<unknown, z.infer<S>>
	try {
		parsed = schema.safeParse(JSON.parse(raw.toString('utf8')))
	} catch {
		raw.fill(0)
		return { ok: false, message: 'Body must be valid JSON' }
	}
	raw.fill(0)
	if (!parsed.success) {
		// Field paths only. Zod issues for a bad rawSecret could echo the value.
		const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))]
		return { ok: false, message: `Invalid fields: ${fields.join(', ')}` }
	}
	return { ok: true, data: parsed.data }
}

// ── POST /api/integrations/chat-capture ──────────────────────────────────

// Agents that may use the key. Humans are never named: they are not subject to grants.
const agentIdsSchema = z.array(z.string().uuid()).max(25)

// One of two shapes: an API key (detected or typed), or a username and password. The
// card an agent puts in the chat sends either, with fromCard set.
const chatCaptureBodySchema = z.union([
	z
		.object({
			sessionId: z.string().uuid(),
			providerMode: z.literal('byo_apikey'),
			detectedProvider: z.enum(CHAT_CAPTURE_PROVIDERS as [string, ...string[]]),
			displayName: z.string().trim().min(1).max(80),
			rawSecret: z.string().min(1).max(4096),
			agentIds: agentIdsSchema.optional(),
			fromCard: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			sessionId: z.string().uuid(),
			providerMode: z.literal('byo_login'),
			displayName: z.string().trim().min(1).max(80),
			username: z.string().min(1).max(LOGIN_USERNAME_MAX_LENGTH),
			password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
			agentIds: agentIdsSchema.optional(),
			fromCard: z.boolean().optional(),
		})
		.strict(),
])

const chatCaptureResponseSchema = z.object({
	integrationId: z.string().uuid(),
	// Null for a capture from an agent's card: active straight away, nothing to undo.
	undoExpiresAt: z.string().nullable(),
	undoUrl: z.string().nullable(),
	// stopped: the old session is gone, the client's marker message respawns it.
	// failed: the key is saved and the old session may still be running without it.
	relaunch: z.enum(['stopped', 'failed']),
})

// No `request.body` on purpose. The request validator would parse the body into
// strings we can never clear; the handler reads the raw buffer itself so it can
// zero it once the secret is parsed. The schema above still guards the shape.
const chatCaptureRoute = createRoute({
	method: 'post',
	path: '/chat-capture',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Vault a secret pasted in chat (humans only)',
	request: { headers: workspaceIdHeader },
	responses: {
		201: {
			description: 'Captured; undoable until undoExpiresAt, or active at once from a card',
			content: { 'application/json': { schema: chatCaptureResponseSchema } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not a human', content: { 'application/json': { schema: errorSchema } } },
		404: {
			description: 'Session not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'NAME_TAKEN: another active or pending-undo key has this env var name',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(chatCaptureRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// Agents never vault secrets: an agent that held one has already seen it.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can vault a key from chat'), 403)
	}

	const parsed = await readSecretBody(c, chatCaptureBodySchema)
	if (!parsed.ok) return c.json(createApiError('BAD_REQUEST', parsed.message), 400)
	const body = parsed.data

	try {
		const common = {
			workspaceId,
			actorId,
			sessionId: body.sessionId,
			displayName: body.displayName,
			agentIds: body.agentIds,
			viaCard: body.fromCard,
		}
		const result = await captureChatSecret(
			db,
			getKmsProvider(),
			body.providerMode === 'byo_login'
				? { ...common, login: { username: body.username, password: body.password } }
				: {
						...common,
						detectedProvider: body.detectedProvider as (typeof CHAT_CAPTURE_PROVIDERS)[number],
						rawSecret: body.rawSecret,
					},
		)

		void capturePosthogEvent('keychain_credential_created', actorId, {
			workspace_id: workspaceId,
			integration_id: result.integrationId,
			provider: result.provider,
			provider_mode: body.providerMode,
			source: 'chat_capture',
			trigger: result.trigger,
		})

		// After the vault transaction has committed: the row is the source of truth
		// before anything is stopped. A failed stop never fails the vault.
		const relaunch = await relaunchChatSession(
			{ db, sessionManager: c.get('sessionManager') },
			{ workspaceId, originSessionId: body.sessionId },
		).catch((err: unknown) => {
			logger.error('Relaunch after chat capture threw', {
				workspaceId,
				sessionId: body.sessionId,
				error: err instanceof Error ? err.name : 'unknown',
			})
			return 'failed' as const
		})

		return c.json(
			{
				integrationId: result.integrationId,
				undoExpiresAt: result.undoExpiresAt?.toISOString() ?? null,
				undoUrl: result.undoExpiresAt ? `/api/integrations/${result.integrationId}/undo` : null,
				relaunch,
			},
			201,
		)
	} catch (err) {
		if (err instanceof ChatCaptureError) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		if (
			err instanceof CredentialNameError ||
			err instanceof CredentialValueError ||
			err instanceof LoginValueError
		) {
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

// ── POST /api/integrations/byo-apikey ────────────────────────────────────

const byoApiKeyBodySchema = z
	.object({
		displayName: z.string().trim().min(1).max(80),
		rawSecret: z.string().min(1).max(4096),
	})
	.strict()

// No `request.body`, same reason as chat-capture: the handler owns the raw bytes.
const byoApiKeyRoute = createRoute({
	method: 'post',
	path: '/byo-apikey',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Vault an API key pasted in the Keychain (humans only)',
	request: { headers: workspaceIdHeader },
	responses: {
		201: {
			description: 'Stored, active, scoped to the member who pasted it',
			content: { 'application/json': { schema: z.object({ integrationId: z.string().uuid() }) } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not a human', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'NAME_TAKEN: another active or pending-undo key has this env var name',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(byoApiKeyRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// Agents never vault secrets: an agent that held one has already seen it.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can add a key to the Keychain'), 403)
	}

	const parsed = await readSecretBody(c, byoApiKeyBodySchema)
	if (!parsed.ok) return c.json(createApiError('BAD_REQUEST', parsed.message), 400)
	const body = parsed.data

	try {
		const result = await createByoApiKey(db, getKmsProvider(), {
			workspaceId,
			actorId,
			displayName: body.displayName,
			rawSecret: body.rawSecret,
		})

		void capturePosthogEvent('keychain_credential_created', actorId, {
			workspace_id: workspaceId,
			integration_id: result.integrationId,
			provider: BYO_APIKEY_PROVIDER,
			provider_mode: 'byo_apikey',
			source: 'admin_ui',
		})

		return c.json({ integrationId: result.integrationId }, 201)
	} catch (err) {
		if (err instanceof CredentialNameError || err instanceof CredentialValueError) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		// Error name only, never the request: a driver error can carry bound params.
		logger.error('Keychain paste failed', {
			workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
}) as RouteHandler<typeof byoApiKeyRoute, Env>)

// ── POST /api/integrations/byo-login ─────────────────────────────────────

const byoLoginBodySchema = z
	.object({
		displayName: z.string().trim().min(1).max(80),
		username: z.string().min(1).max(LOGIN_USERNAME_MAX_LENGTH),
		password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
	})
	.strict()

// No `request.body`, same reason as chat-capture: the handler owns the raw bytes.
const byoLoginRoute = createRoute({
	method: 'post',
	path: '/byo-login',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Vault a username and password added in the Keychain (humans only)',
	request: { headers: workspaceIdHeader },
	responses: {
		201: {
			description: 'Stored, active, scoped to the member who added it',
			content: { 'application/json': { schema: z.object({ integrationId: z.string().uuid() }) } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not a human', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'NAME_TAKEN: another active or pending-undo credential has this env var name',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(byoLoginRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// Agents never vault secrets: an agent that held one has already seen it.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can add a login to the Keychain'), 403)
	}

	const parsed = await readSecretBody(c, byoLoginBodySchema)
	if (!parsed.ok) return c.json(createApiError('BAD_REQUEST', parsed.message), 400)
	const body = parsed.data

	try {
		const result = await createByoLogin(db, getKmsProvider(), {
			workspaceId,
			actorId,
			displayName: body.displayName,
			username: body.username,
			password: body.password,
		})

		void capturePosthogEvent('keychain_credential_created', actorId, {
			workspace_id: workspaceId,
			integration_id: result.integrationId,
			provider: BYO_LOGIN_PROVIDER,
			provider_mode: 'byo_login',
			source: 'admin_ui',
		})

		return c.json({ integrationId: result.integrationId }, 201)
	} catch (err) {
		if (
			err instanceof CredentialNameError ||
			err instanceof CredentialValueError ||
			err instanceof LoginValueError
		) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		// Error name only, never the request: a driver error can carry bound params.
		logger.error('Keychain login failed', {
			workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
}) as RouteHandler<typeof byoLoginRoute, Env>)

// ── POST /api/integrations/:id/undo ──────────────────────────────────────

const undoRoute = createRoute({
	method: 'post',
	path: '/{id}/undo',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Undo a chat capture inside its 5 minute window',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Undone: the secret is zeroised, the row is kept for the audit chain',
			content: {
				'application/json': {
					schema: z.object({
						id: z.string().uuid(),
						status: z.literal('undone'),
						// False when the session holding the key could not be stopped; the key is
						// already destroyed, the session just still has it in its env.
						sessionEnded: z.boolean(),
					}),
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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

	// The key is gone from the vault. End the session that holds it in its env; it is
	// not respawned, so the next message starts one without the key. A relaunch in
	// flight finishes first.
	const sessionEnded = row.originSessionId
		? await endSessionHoldingKey(
				{ db, sessionManager: c.get('sessionManager') },
				{ workspaceId, originSessionId: row.originSessionId },
			).catch((err: unknown) => {
				logger.error('Ending the session after undo threw', {
					workspaceId,
					integrationId: id,
					error: err instanceof Error ? err.name : 'unknown',
				})
				return false
			})
		: true
	if (!sessionEnded) {
		logger.error('Undo: the session holding the undone key is still running', {
			workspaceId,
			integrationId: id,
			sessionId: row.originSessionId,
		})
	}
	return c.json({ id, status: 'undone' as const, sessionEnded }, 200)
}) as RouteHandler<typeof undoRoute, Env>)

// ── POST /api/integrations/:id/remove ────────────────────────────────────

const removeRoute = createRoute({
	method: 'post',
	path: '/{id}/remove',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Remove a saved API key or login at any time and destroy its secret (humans only)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Removed: the secret is zeroised, the row is kept for the audit chain',
			content: {
				'application/json': {
					schema: z.object({
						id: z.string().uuid(),
						status: z.literal('undone'),
						// False when the session that held it could not be stopped. The secret is
						// already destroyed; that session just still has it in its env until it ends.
						sessionEnded: z.boolean(),
					}),
				},
			},
		},
		403: {
			description: 'Not a person, or neither its creator nor a workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'Not a removable key or login, or already removed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(removeRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')

	// Agents never remove a credential: only a person decides what the vault holds.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can remove a credential'), 403)
	}

	// Same rule as editing who can use it: the person who saved it, or a workspace admin
	// or owner. Locked, so two removals queue and the second finds it already gone.
	const outcome = await db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				createdBy: integrations.createdBy,
				providerMode: integrations.providerMode,
				status: integrations.status,
				source: integrations.source,
				provider: integrations.provider,
				originSessionId: integrations.originSessionId,
			})
			.from(integrations)
			.where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
			.for('update')
			.limit(1)
		if (!row) return { kind: 'not_found' as const }
		if (
			row.createdBy !== callerId &&
			!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))
		) {
			return { kind: 'forbidden' as const }
		}
		// Only a saved key or login: an OAuth connection or registered provider is
		// disconnected on the Integrations page, which also revokes it upstream.
		if (
			(row.providerMode !== 'byo_apikey' && row.providerMode !== 'byo_login') ||
			(row.status !== 'active' && row.status !== 'pending_undo')
		) {
			return { kind: 'not_removable' as const }
		}

		// Same end state as an undo: the secret and its wrapped key are gone, the row stays
		// so the audit chain keeps its foreign key.
		await tx
			.update(integrations)
			.set({
				status: 'undone',
				credentials: null,
				dekCiphertext: null,
				undoExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, id))
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId: id,
			actorId: callerId,
			sessionId: row.originSessionId,
			action: 'undone',
			source: row.source,
			requestId: `remove:${id}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: {
				status: 'undone',
				reason: 'removed',
				provider: row.provider,
				provider_mode: row.providerMode,
				source: row.source,
			},
		})
		return { kind: 'removed' as const, row }
	})

	if (outcome.kind === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)
	}
	if (outcome.kind === 'forbidden') {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only the person who saved this, or a workspace admin or owner, can remove it',
			),
			403,
		)
	}
	if (outcome.kind === 'not_removable') {
		return c.json(
			createApiError('CONFLICT', 'This is not a saved key or login, or it is already removed'),
			409,
		)
	}

	void capturePosthogEvent('keychain_credential_removed', callerId, {
		workspace_id: workspaceId,
		integration_id: id,
		provider: outcome.row.provider,
		provider_mode: outcome.row.providerMode,
	})

	// End the session the credential was saved from, as an undo does, so it is not left
	// holding it. Other running sessions keep what they were launched with until they end;
	// none starts with it again.
	const sessionEnded = outcome.row.originSessionId
		? await endSessionHoldingKey(
				{ db, sessionManager: c.get('sessionManager') },
				{ workspaceId, originSessionId: outcome.row.originSessionId },
			).catch((err: unknown) => {
				logger.error('Ending the session after a removal threw', {
					workspaceId,
					integrationId: id,
					error: err instanceof Error ? err.name : 'unknown',
				})
				return false
			})
		: true
	return c.json({ id, status: 'undone' as const, sessionEnded }, 200)
}) as RouteHandler<typeof removeRoute, Env>)

// ── POST /api/integrations/:id/update ────────────────────────────────────

// A new name, a new secret, or both. A key takes rawSecret; a login takes username and password
// together. No `request.body`: the handler owns the raw bytes so it can zero them.
const updateBodySchema = z
	.object({
		displayName: z.string().trim().min(1).max(80).optional(),
		rawSecret: z.string().min(1).max(4096).optional(),
		username: z.string().min(1).max(LOGIN_USERNAME_MAX_LENGTH).optional(),
		password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH).optional(),
	})
	.strict()
	.refine((b) => (b.username === undefined) === (b.password === undefined), {
		message: 'username and password are replaced together',
		path: ['username'],
	})
	.refine(
		(b) =>
			b.displayName !== undefined ||
			b.rawSecret !== undefined ||
			(b.username !== undefined && b.password !== undefined),
		{ message: 'Nothing to change', path: ['displayName'] },
	)
	.refine((b) => b.rawSecret === undefined || b.username === undefined, {
		message: 'a credential is a key or a login, not both',
		path: ['rawSecret'],
	})

const updateRoute = createRoute({
	method: 'post',
	path: '/{id}/update',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Rename a saved API key or login, replace its secret, or both (humans only)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description:
				'Saved. A running session keeps what it started with; the next one gets the change',
			content: {
				'application/json': {
					schema: z.object({
						id: z.string().uuid(),
						renamed: z.boolean(),
						secretReplaced: z.boolean(),
					}),
				},
			},
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: {
			description: 'Not a person, or neither its creator nor a workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'NAME_TAKEN, or not an active saved key or login',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')

	// Agents never change what the vault holds.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can edit a credential'), 403)
	}

	const parsed = await readSecretBody(c, updateBodySchema)
	if (!parsed.ok) return c.json(createApiError('BAD_REQUEST', parsed.message), 400)
	const body = parsed.data

	try {
		const outcome = await updateCredential(
			db,
			getKmsProvider(),
			{
				workspaceId,
				integrationId: id,
				actorId: callerId,
				displayName: body.displayName,
				rawSecret: body.rawSecret,
				login:
					body.username !== undefined && body.password !== undefined
						? { username: body.username, password: body.password }
						: undefined,
			},
			// The same rule as removing it: the person who saved it, or a workspace admin or owner.
			async (createdBy) =>
				createdBy === callerId || (await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId)),
		)
		if (outcome.kind === 'not_found') {
			return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)
		}
		if (outcome.kind === 'forbidden') {
			return c.json(
				createApiError(
					'FORBIDDEN',
					'Only the person who saved this, or a workspace admin or owner, can edit it',
				),
				403,
			)
		}
		if (outcome.kind === 'not_editable') {
			return c.json(createApiError('CONFLICT', 'This is not an active saved key or login'), 409)
		}
		if (outcome.kind === 'wrong_shape') {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'An API key takes a key, and a login takes a username and password',
				),
				400,
			)
		}

		void capturePosthogEvent('keychain_credential_updated', callerId, {
			workspace_id: workspaceId,
			integration_id: id,
			renamed: outcome.renamed,
			secret_replaced: outcome.secretReplaced,
		})
		return c.json({ id, renamed: outcome.renamed, secretReplaced: outcome.secretReplaced }, 200)
	} catch (err) {
		if (
			err instanceof CredentialNameError ||
			err instanceof CredentialValueError ||
			err instanceof LoginValueError
		) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		// Error name only, never the request: a driver error can carry bound params.
		logger.error('Keychain edit failed', {
			workspaceId,
			integrationId: id,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
}) as RouteHandler<typeof updateRoute, Env>)

// ── POST /api/integrations/:id/relaunch ──────────────────────────────────

const relaunchRoute = createRoute({
	method: 'post',
	path: '/{id}/relaunch',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Retry stopping the session after a chat capture whose relaunch failed',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'stopped: the client may now post its next message. failed: try again.',
			content: {
				'application/json': { schema: z.object({ relaunch: z.enum(['stopped', 'failed']) }) },
			},
		},
		403: {
			description: 'Not the person who captured it, or another workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'The key is no longer in the vault (undone)',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(relaunchRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')

	const [row] = await db
		.select({
			workspaceId: integrations.workspaceId,
			createdBy: integrations.createdBy,
			status: integrations.status,
			originSessionId: integrations.originSessionId,
		})
		.from(integrations)
		.where(eq(integrations.id, id))
		.limit(1)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)
	if (row.workspaceId !== workspaceId || row.createdBy !== callerId) {
		return c.json(
			createApiError('FORBIDDEN', 'Only the person who captured this key can relaunch for it'),
			403,
		)
	}
	// Nothing to relaunch for a key that is gone, and a retry must never start a session
	// that is waiting on a credential that no longer exists.
	if (!row.originSessionId || !['pending_undo', 'active'].includes(row.status)) {
		return c.json(createApiError('CONFLICT', 'This key is no longer in the vault'), 409)
	}

	const relaunch = await relaunchChatSession(
		{ db, sessionManager: c.get('sessionManager') },
		{ workspaceId, originSessionId: row.originSessionId },
	).catch((err: unknown) => {
		logger.error('Relaunch retry threw', {
			workspaceId,
			integrationId: id,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return 'failed' as const
	})
	return c.json({ relaunch }, 200)
}) as RouteHandler<typeof relaunchRoute, Env>)

// ── POST /api/integrations/:id/rotate-dek ────────────────────────────────

const rotateDekRoute = createRoute({
	method: 'post',
	path: '/{id}/rotate-dek',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Re-wrap one credential under a fresh data key and the current master key',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Re-wrapped. The decrypted value is unchanged',
			content: {
				'application/json': {
					schema: z.object({ id: z.string().uuid(), status: z.literal('rotated') }),
				},
			},
		},
		403: {
			description: 'Only a human workspace admin or owner can rotate',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'A legacy row (no data key to rotate), or the row changed while rotating',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(rotateDekRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')

	if (!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only a workspace admin or owner can rotate a data key'),
			403,
		)
	}

	const outcome = await rotateIntegrationDek(db, getKmsProvider(), {
		integrationId: id,
		workspaceId,
		actorId: callerId,
		origin: 'manual',
	})
	if (outcome === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)
	}
	if (outcome === 'not_envelope') {
		return c.json(
			createApiError(
				'CONFLICT',
				'This credential is not envelope encrypted yet, so it has no data key',
			),
			409,
		)
	}
	if (outcome === 'changed') {
		return c.json(
			createApiError('CONFLICT', 'The credential changed while rotating, try again'),
			409,
		)
	}
	return c.json({ id, status: 'rotated' as const }, 200)
}) as RouteHandler<typeof rotateDekRoute, Env>)

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
