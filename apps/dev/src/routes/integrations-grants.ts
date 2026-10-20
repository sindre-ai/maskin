import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database, Transaction } from '@maskin/db'
import { agentGrants, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { actorsAreWorkspaceAgents, isKeychainMode } from '../lib/integrations/agent-access'
import {
	removeAgentGrant,
	replaceAgentGrants,
	upsertAgentGrant,
} from '../lib/integrations/agent-grants'
import { insertCredentialAccessLog } from '../lib/integrations/credential-audit'
import {
	agentGrantAccessSchema,
	agentGrantSchema,
	errorSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
	}
}

// Agent grants for any integration: which agents may use it, and how. Keychain
// credentials are explicit-grant and on/off (stored as read_write); every other
// integration has a default for agents with no row plus per-agent overrides.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const grantParams = z.object({
	id: z.string().uuid(),
	actorId: z.string().uuid(),
})
const idParams = z.object({ id: z.string().uuid() })

const grantsResponseSchema = z.object({
	integrationId: z.string().uuid(),
	// 'keychain': explicit-grant, on/off. 'standard': default plus overrides.
	mode: z.enum(['keychain', 'standard']),
	defaultAgentAccess: z.enum(['read', 'none']),
	grants: z.array(agentGrantSchema),
})

// ── GET /api/integrations/:id/grants ─────────────────────────────────────

const getGrantsRoute = createRoute({
	method: 'get',
	path: '/{id}/grants',
	tags: ['integrations'],
	summary: 'List which agents may use an integration, and how',
	request: { headers: workspaceIdHeader, params: idParams },
	responses: {
		200: {
			description: 'Default access and explicit agent grants',
			content: { 'application/json': { schema: grantsResponseSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getGrantsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const [row] = await db
		.select({
			providerMode: integrations.providerMode,
			defaultAgentAccess: integrations.defaultAgentAccess,
		})
		.from(integrations)
		.where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)

	const grants = await db
		.select({ actorId: agentGrants.actorId, access: agentGrants.access })
		.from(agentGrants)
		.where(eq(agentGrants.integrationId, id))

	return c.json(
		{
			integrationId: id,
			mode: isKeychainMode(row.providerMode) ? ('keychain' as const) : ('standard' as const),
			defaultAgentAccess: row.defaultAgentAccess,
			grants,
		},
		200,
	)
}) as RouteHandler<typeof getGrantsRoute, Env>)

// ── shared: who may change grants, on what ───────────────────────────────

type Editable =
	| { ok: true; provider: string; providerMode: string; before: unknown }
	| { ok: false; reason: 'not_found' | 'forbidden' | 'not_editable' }

/** Locks the row and checks the caller may change its grants. Humans only. */
async function loadEditable(
	db: Database,
	tx: Transaction,
	input: { id: string; workspaceId: string; callerId: string },
): Promise<Editable> {
	const [row] = await tx
		.select({
			createdBy: integrations.createdBy,
			providerMode: integrations.providerMode,
			status: integrations.status,
			provider: integrations.provider,
			defaultAgentAccess: integrations.defaultAgentAccess,
		})
		.from(integrations)
		.where(and(eq(integrations.id, input.id), eq(integrations.workspaceId, input.workspaceId)))
		.for('update')
		.limit(1)
	if (!row) return { ok: false, reason: 'not_found' }
	if (
		row.createdBy !== input.callerId &&
		!(await isWorkspaceHumanAdminOrOwner(db, input.callerId, input.workspaceId))
	) {
		return { ok: false, reason: 'forbidden' }
	}
	if (row.status !== 'active') return { ok: false, reason: 'not_editable' }
	return {
		ok: true,
		provider: row.provider,
		providerMode: row.providerMode,
		before: row.defaultAgentAccess,
	}
}

function failure(reason: string): {
	error: ReturnType<typeof createApiError>
	status: 400 | 403 | 404 | 409
} {
	switch (reason) {
		case 'not_found':
			return { error: createApiError('NOT_FOUND', 'Integration not found'), status: 404 }
		case 'forbidden':
			return {
				error: createApiError(
					'FORBIDDEN',
					'Only the person who connected this or a workspace admin can change which agents may use it',
				),
				status: 403,
			}
		case 'not_editable':
			return {
				error: createApiError('CONFLICT', 'Access can only be changed on an active integration'),
				status: 409,
			}
		case 'outside':
			return {
				error: createApiError('BAD_REQUEST', 'That actor is not an agent in this workspace'),
				status: 400,
			}
		case 'keychain_access':
			return {
				error: createApiError(
					'BAD_REQUEST',
					'A saved key or login is on or off for an agent: use read_write',
				),
				status: 400,
			}
		default:
			return {
				error: createApiError('BAD_REQUEST', 'Not allowed for this integration'),
				status: 400,
			}
	}
}

const errorResponses = {
	400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	409: { description: 'Not active', content: { 'application/json': { schema: errorSchema } } },
}

// ── PUT /api/integrations/:id/grants ─────────────────────────────────────

const replaceGrantsRoute = createRoute({
	method: 'put',
	path: '/{id}/grants',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Replace every explicit agent grant on an integration (humans only)',
	request: {
		headers: workspaceIdHeader,
		params: idParams,
		body: {
			content: {
				'application/json': {
					schema: z.object({ grants: z.array(agentGrantSchema).max(100) }).strict(),
				},
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Saved. Applies to sessions started after this call',
			content: { 'application/json': { schema: z.object({ grants: z.array(agentGrantSchema) }) } },
		},
		...errorResponses,
	},
})

app.openapi(replaceGrantsRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')
	const { grants } = c.req.valid('json')

	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can change agent access'), 403)
	}

	const outcome = await db.transaction(async (tx) => {
		const target = await loadEditable(db, tx, { id, workspaceId, callerId })
		if (!target.ok) return target.reason
		const keychain = isKeychainMode(target.providerMode as never)
		if (keychain && grants.some((g) => g.access !== 'read_write')) {
			return 'keychain_access' as const
		}
		if (
			!(await actorsAreWorkspaceAgents(
				tx,
				workspaceId,
				grants.map((g) => g.actorId),
			))
		) {
			return 'outside' as const
		}
		const { before, after } = await replaceAgentGrants(tx, {
			workspaceId,
			integrationId: id,
			grants,
			createdBy: callerId,
		})
		if (keychain) {
			await insertCredentialAccessLog(tx, {
				workspaceId,
				integrationId: id,
				actorId: callerId,
				action: 'scope_changed',
				source: 'admin_ui',
				requestId: `grant-change:${id}:${randomUUID()}`,
			})
		}
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: {
				change: 'agent_grants',
				provider: target.provider,
				grants_before: before,
				grants_after: after,
			},
		})
		return after
	})

	if (typeof outcome === 'string') {
		const f = failure(outcome)
		return c.json(f.error, f.status)
	}
	return c.json({ grants: outcome }, 200)
}) as RouteHandler<typeof replaceGrantsRoute, Env>)

// ── PUT /api/integrations/:id/grants/:actorId ────────────────────────────

const putGrantRoute = createRoute({
	method: 'put',
	path: '/{id}/grants/{actorId}',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Give an agent access to an integration, or change it (humans only)',
	request: {
		headers: workspaceIdHeader,
		params: grantParams,
		body: {
			content: {
				'application/json': { schema: z.object({ access: agentGrantAccessSchema }).strict() },
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Saved. Applies to sessions started after this call',
			content: { 'application/json': { schema: agentGrantSchema } },
		},
		...errorResponses,
	},
})

app.openapi(putGrantRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id, actorId } = c.req.valid('param')
	const { access } = c.req.valid('json')

	// Grants come from a person, never from a session.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can change agent access'), 403)
	}

	const outcome = await db.transaction(async (tx) => {
		const target = await loadEditable(db, tx, { id, workspaceId, callerId })
		if (!target.ok) return target.reason
		if (isKeychainMode(target.providerMode as never) && access !== 'read_write') {
			return 'keychain_access' as const
		}
		if (!(await actorsAreWorkspaceAgents(tx, workspaceId, [actorId]))) return 'outside' as const

		const previous = await upsertAgentGrant(tx, {
			workspaceId,
			integrationId: id,
			actorId,
			access,
			createdBy: callerId,
		})
		if (isKeychainMode(target.providerMode as never)) {
			await insertCredentialAccessLog(tx, {
				workspaceId,
				integrationId: id,
				actorId: callerId,
				action: 'scope_changed',
				source: 'admin_ui',
				requestId: `grant-change:${id}:${randomUUID()}`,
			})
		}
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: {
				change: 'agent_grant',
				provider: target.provider,
				agent_id: actorId,
				access_before: previous,
				access_after: access,
			},
		})
		return 'saved' as const
	})

	if (outcome !== 'saved') {
		const f = failure(outcome)
		return c.json(f.error, f.status)
	}
	return c.json({ actorId, access }, 200)
}) as RouteHandler<typeof putGrantRoute, Env>)

// ── DELETE /api/integrations/:id/grants/:actorId ─────────────────────────

const deleteGrantRoute = createRoute({
	method: 'delete',
	path: '/{id}/grants/{actorId}',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Remove an agent grant (humans only). The agent falls back to the default',
	request: { headers: workspaceIdHeader, params: grantParams },
	responses: {
		200: {
			description: 'Removed. Applies to sessions started after this call',
			content: { 'application/json': { schema: z.object({ actorId: z.string().uuid() }) } },
		},
		...errorResponses,
	},
})

app.openapi(deleteGrantRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id, actorId } = c.req.valid('param')

	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can change agent access'), 403)
	}

	const outcome = await db.transaction(async (tx) => {
		const target = await loadEditable(db, tx, { id, workspaceId, callerId })
		if (!target.ok) return target.reason
		const previous = await removeAgentGrant(tx, { integrationId: id, actorId })
		if (previous === null) return 'saved' as const
		if (isKeychainMode(target.providerMode as never)) {
			await insertCredentialAccessLog(tx, {
				workspaceId,
				integrationId: id,
				actorId: callerId,
				action: 'scope_changed',
				source: 'admin_ui',
				requestId: `grant-change:${id}:${randomUUID()}`,
			})
		}
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: {
				change: 'agent_grant',
				provider: target.provider,
				agent_id: actorId,
				access_before: previous,
				access_after: null,
			},
		})
		return 'saved' as const
	})

	if (outcome !== 'saved') {
		const f = failure(outcome)
		return c.json(f.error, f.status)
	}
	return c.json({ actorId }, 200)
}) as RouteHandler<typeof deleteGrantRoute, Env>)

// ── PUT /api/integrations/:id/default-access ─────────────────────────────

const putDefaultRoute = createRoute({
	method: 'put',
	path: '/{id}/default-access',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Set what agents without their own grant may do (humans only)',
	request: {
		headers: workspaceIdHeader,
		params: idParams,
		body: {
			content: {
				'application/json': {
					schema: z.object({ defaultAgentAccess: z.enum(['read', 'none']) }).strict(),
				},
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Saved. Applies to sessions started after this call',
			content: {
				'application/json': {
					schema: z.object({ defaultAgentAccess: z.enum(['read', 'none']) }),
				},
			},
		},
		...errorResponses,
	},
})

app.openapi(putDefaultRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')
	const { defaultAgentAccess } = c.req.valid('json')

	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can change agent access'), 403)
	}

	const outcome = await db.transaction(async (tx) => {
		const target = await loadEditable(db, tx, { id, workspaceId, callerId })
		if (!target.ok) return target.reason
		// A saved key or login has no default: it is always explicit-grant.
		if (isKeychainMode(target.providerMode as never)) return 'keychain_default' as const
		await tx
			.update(integrations)
			.set({ defaultAgentAccess, updatedAt: new Date() })
			.where(eq(integrations.id, id))
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: {
				change: 'default_agent_access',
				provider: target.provider,
				access_before: target.before,
				access_after: defaultAgentAccess,
			},
		})
		return 'saved' as const
	})

	if (outcome === 'keychain_default') {
		return c.json(
			createApiError('BAD_REQUEST', 'A saved key or login has no default: grant agents one by one'),
			400,
		)
	}
	if (outcome !== 'saved') {
		const f = failure(outcome)
		return c.json(f.error, f.status)
	}
	return c.json({ defaultAgentAccess }, 200)
}) as RouteHandler<typeof putDefaultRoute, Env>)

export default app
