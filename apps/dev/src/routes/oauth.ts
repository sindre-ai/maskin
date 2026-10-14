import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { evictOAuthTokens, mintToken } from '@maskin/auth'
import { isMcpOAuthEnabled } from '@maskin/auth/mcp'
import type { Database } from '@maskin/db'
import {
	oauthAuthorizationCodes,
	oauthGrants,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import {
	OAUTH_CODE_TTL_S,
	OAUTH_SCOPE,
	oauthApproveBodySchema,
	oauthAuthorizeParamsSchema,
	oauthDenyBodySchema,
	oauthErrorBodySchema,
	oauthGrantListSchema,
	oauthPreviewResponseSchema,
	oauthRedirectResponseSchema,
} from '@maskin/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import {
	captureAuthorizeStarted,
	captureConsentApproved,
	captureConsentDenied,
	capturePreviewRejected,
} from '../lib/oauth-server/analytics'
import {
	type AuthorizeFailure,
	buildApproveRedirect,
	buildDenyRedirect,
	redirectHost,
	validateAuthorizeRequest,
} from '../lib/oauth-server/authorize'
import { listGrantsForActor, revokeGrant } from '../lib/oauth-server/grants'
import { createRateLimiter } from '../lib/oauth-server/rate-limit'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'

// The server half of the Claude connector consent page (docs/reference/mcp-oauth.md). The page
// itself is a web route; it calls these with the person's own API key.
//
// preview, approve and deny issue new access, so they sit behind the MASKIN_MCP_OAUTH_ENABLED
// switch (404 when off) and the mcp-oauth-consent flag (403 access_denied for non-testers). List
// and revoke do not: a person must always be able to see and end their connections. A Claude
// token (mat_) never gets here: authMiddleware refuses every /api/oauth route for it, because an
// OAuth client must not approve its own access.

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** 30 tries a minute per person across preview, approve and deny. */
const allowAuthorize = createRateLimiter(30, 60_000)

const accessDeniedBody = (description: string) => ({
	error: 'access_denied' as const,
	error_description: description,
})

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } })

const authorizeErrorResponses = {
	400: {
		description: 'The request was refused; error is one of seven fixed codes',
		content: jsonContent(oauthErrorBodySchema),
	},
	403: {
		description: 'access_denied: flag off for this person, or the caller is not a person',
		content: jsonContent(oauthErrorBodySchema),
	},
	404: {
		description: 'The MASKIN_MCP_OAUTH_ENABLED switch is off',
		content: jsonContent(errorSchema),
	},
	429: { description: 'Too many tries', content: jsonContent(errorSchema) },
}

/** A refusal from the checks shared by preview, approve and deny. */
type Gate = {
	status: 403 | 404 | 429
	body: ReturnType<typeof accessDeniedBody> | ReturnType<typeof createApiError>
	rateLimited?: true
}

/**
 * The checks shared by preview, approve and deny, in the order the spec fixes: switch, person
 * and flag, rate limit. Returns the refusal to send, or null to carry on. The switch and flag
 * refusals are not events: a person who is not let in is not part of the funnel.
 */
function gateAuthorize(caller: { actorId: string; actorType: string }): Gate | null {
	if (!isMcpOAuthEnabled()) return { status: 404, body: createApiError('NOT_FOUND', 'Not found') }
	if (caller.actorType !== 'human') {
		return { status: 403, body: accessDeniedBody('Only a person can approve a connection') }
	}
	if (!isFlagEnabled(caller.actorId, FLAGS.MCP_OAUTH_CONSENT)) {
		return {
			status: 403,
			body: accessDeniedBody('Connecting apps is not available for your account yet'),
		}
	}
	if (!allowAuthorize(caller.actorId)) {
		return {
			status: 429,
			body: createApiError('RATE_LIMITED', 'Too many tries'),
			rateLimited: true,
		}
	}
	return null
}

function failureBody(failure: AuthorizeFailure) {
	return {
		error: failure.error,
		error_description: failure.description,
		...(failure.redirectUrl ? { redirect_url: failure.redirectUrl } : {}),
	}
}

// ── GET /api/oauth/authorize/preview ─────────────────────────────────

const previewRoute = createRoute({
	method: 'get',
	path: '/authorize/preview',
	tags: ['oauth'],
	summary: 'Check a Claude authorize request and list the workspaces the person can connect',
	request: { query: oauthAuthorizeParamsSchema },
	responses: {
		200: {
			description: 'What the consent page shows',
			content: jsonContent(oauthPreviewResponseSchema),
		},
		...authorizeErrorResponses,
	},
})

app.openapi(previewRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const params = c.req.valid('query')
	c.header('Cache-Control', 'no-store')

	const gate = gateAuthorize({ actorId, actorType: c.get('actorType') })
	if (gate) {
		if (gate.rateLimited) {
			capturePreviewRejected({ actorId, clientId: params.client_id, reason: 'rate_limited' })
			c.header('Retry-After', '60')
		}
		return c.json(gate.body, gate.status)
	}

	const checked = validateAuthorizeRequest(params)
	if (!checked.ok) {
		capturePreviewRejected({ actorId, clientId: params.client_id, reason: checked.failure.error })
		return c.json(failureBody(checked.failure), 400)
	}
	const { request } = checked

	const memberWorkspaces = await db
		.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(eq(workspaceMembers.actorId, actorId))
		.orderBy(asc(workspaces.name))

	captureAuthorizeStarted({
		actorId,
		clientId: request.client.client_id,
		workspaceCount: memberWorkspaces.length,
	})
	return c.json(
		{
			client: {
				client_id: request.client.client_id,
				client_name: request.client.client_name,
				redirect_host: redirectHost(request.redirectUri),
			},
			workspaces: memberWorkspaces,
			scope: OAUTH_SCOPE,
		},
		200,
	)
}) as RouteHandler<typeof previewRoute, Env>)

// ── POST /api/oauth/authorize/approve ────────────────────────────────

const approveRoute = createRoute({
	method: 'post',
	path: '/authorize/approve',
	tags: ['oauth'],
	summary: 'Approve a Claude connection for one workspace and return where to send the browser',
	request: { body: { content: jsonContent(oauthApproveBodySchema) } },
	responses: {
		200: {
			description: 'The redirect back to the client, carrying a one-time code',
			content: jsonContent(oauthRedirectResponseSchema),
		},
		...authorizeErrorResponses,
		409: {
			description: 'Two approvals for the same workspace raced; try again',
			content: jsonContent(errorSchema),
		},
	},
})

/** True for a Postgres unique violation, however the driver wrapped it. */
function isUniqueViolation(err: unknown): boolean {
	const e = err as { code?: string; cause?: { code?: string } }
	return e?.code === '23505' || e?.cause?.code === '23505'
}

app.openapi(approveRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	c.header('Cache-Control', 'no-store')

	const gate = gateAuthorize({ actorId, actorType: c.get('actorType') })
	if (gate) return c.json(gate.body, gate.status)

	const checked = validateAuthorizeRequest(body)
	if (!checked.ok) return c.json(failureBody(checked.failure), 400)
	const { request } = checked
	const clientId = request.client.client_id
	const code = mintToken('')

	let outcome: { kind: 'not_member' } | { kind: 'ok'; grantId: string; replaced: number }
	try {
		outcome = await db.transaction(async (tx) => {
			const [member] = await tx
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.actorId, actorId),
						eq(workspaceMembers.workspaceId, body.workspace_id),
					),
				)
				.limit(1)
			if (!member) return { kind: 'not_member' as const }

			// One live connection per person, workspace and client: approving again replaces the
			// old one (and its tokens) in the same transaction.
			const live = await tx
				.select({ id: oauthGrants.id })
				.from(oauthGrants)
				.where(
					and(
						eq(oauthGrants.actorId, actorId),
						eq(oauthGrants.workspaceId, body.workspace_id),
						eq(oauthGrants.clientId, clientId),
						isNull(oauthGrants.revokedAt),
					),
				)
			let replaced = 0
			for (const old of live) {
				if (await revokeGrant(tx, { grantId: old.id, reason: 'user', byActorId: actorId })) {
					replaced += 1
				}
			}

			const [grant] = await tx
				.insert(oauthGrants)
				.values({
					actorId,
					workspaceId: body.workspace_id,
					clientId,
					clientName: request.client.client_name,
					scope: OAUTH_SCOPE,
					resource: request.resource,
				})
				.returning({ id: oauthGrants.id })
			if (!grant) throw new Error('Failed to insert the grant')
			await tx.insert(oauthAuthorizationCodes).values({
				codeHash: code.hash,
				grantId: grant.id,
				redirectUri: request.redirectUri,
				codeChallenge: request.codeChallenge,
				resource: request.resource,
				expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_S * 1000),
			})
			await recordEvent(tx, {
				workspaceId: body.workspace_id,
				actorId,
				action: 'oauth_grant_created',
				entityType: 'oauth_grant',
				entityId: grant.id,
				data: {
					client_id: clientId,
					client_name: request.client.client_name,
					scope: OAUTH_SCOPE,
					redirect_host: redirectHost(request.redirectUri),
					resource: request.resource,
				},
			})
			return { kind: 'ok' as const, grantId: grant.id, replaced }
		})
	} catch (err) {
		// Two approvals racing for the same workspace: the unique index let one win.
		if (isUniqueViolation(err)) {
			return c.json(
				createApiError('CONFLICT', 'A connection for this workspace is being set up'),
				409,
			)
		}
		throw err
	}

	if (outcome.kind === 'not_member') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (outcome.replaced > 0) evictOAuthTokens()

	captureConsentApproved({
		actorId,
		clientId,
		workspaceId: body.workspace_id,
		grantId: outcome.grantId,
	})
	return c.json({ redirect_url: buildApproveRedirect(request, code.raw) }, 200)
}) as RouteHandler<typeof approveRoute, Env>)

// ── POST /api/oauth/authorize/deny ───────────────────────────────────

const denyRoute = createRoute({
	method: 'post',
	path: '/authorize/deny',
	tags: ['oauth'],
	summary: 'Deny a Claude connection and return where to send the browser (access_denied)',
	request: { body: { content: jsonContent(oauthDenyBodySchema) } },
	responses: {
		200: {
			description: 'The access_denied redirect back to the client',
			content: jsonContent(oauthRedirectResponseSchema),
		},
		...authorizeErrorResponses,
	},
})

app.openapi(denyRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	c.header('Cache-Control', 'no-store')

	const gate = gateAuthorize({ actorId, actorType: c.get('actorType') })
	if (gate) return c.json(gate.body, gate.status)

	const checked = validateAuthorizeRequest(body)
	if (!checked.ok) return c.json(failureBody(checked.failure), 400)

	// The workspace the person had picked, for the funnel only, and only if it is really theirs.
	let workspaceId: string | undefined
	if (body.workspace_id) {
		const [member] = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.actorId, actorId),
					eq(workspaceMembers.workspaceId, body.workspace_id),
				),
			)
			.limit(1)
		if (member) workspaceId = body.workspace_id
	}

	// Nothing is written: a denial leaves no database rows.
	captureConsentDenied({ actorId, clientId: checked.request.client.client_id, workspaceId })
	return c.json({ redirect_url: buildDenyRedirect(checked.request) }, 200)
}) as RouteHandler<typeof denyRoute, Env>)

// ── GET /api/oauth/grants ────────────────────────────────────────────

const listGrantsRoute = createRoute({
	method: 'get',
	path: '/grants',
	tags: ['oauth'],
	summary: "The signed-in person's live Claude connections, one per workspace",
	responses: {
		200: {
			description: 'Connections that still work',
			content: jsonContent(oauthGrantListSchema),
		},
	},
})

app.openapi(listGrantsRoute, (async (c) => {
	c.header('Cache-Control', 'no-store')
	return c.json(await listGrantsForActor(c.get('db'), c.get('actorId')), 200)
}) as RouteHandler<typeof listGrantsRoute, Env>)

// ── DELETE /api/oauth/grants/:id ─────────────────────────────────────

const revokeGrantRoute = createRoute({
	method: 'delete',
	path: '/grants/{id}',
	tags: ['oauth'],
	summary: 'Disconnect: end one of your own Claude connections at once',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'The connection is ended',
			content: jsonContent(z.object({ revoked: z.literal(true) })),
		},
		404: { description: 'No such connection for this person', content: jsonContent(errorSchema) },
	},
})

app.openapi(revokeGrantRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	c.header('Cache-Control', 'no-store')

	const [grant] = await db
		.select({ id: oauthGrants.id })
		.from(oauthGrants)
		.where(and(eq(oauthGrants.id, id), eq(oauthGrants.actorId, actorId)))
		.limit(1)
	if (!grant) return c.json(createApiError('NOT_FOUND', 'Connection not found'), 404)

	await db.transaction((tx) => revokeGrant(tx, { grantId: id, reason: 'user', byActorId: actorId }))
	evictOAuthTokens()
	logger.info('OAuth connection disconnected by its owner', { grantId: id })
	return c.json({ revoked: true as const }, 200)
}) as RouteHandler<typeof revokeGrantRoute, Env>)

export default app
