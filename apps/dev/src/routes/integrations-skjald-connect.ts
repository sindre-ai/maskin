import { randomBytes } from 'node:crypto'
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, integrations, workspaceMembers, workspaces } from '@maskin/db/schema'
import {
	skjaldConnectAuthorizeBodySchema,
	skjaldConnectAuthorizeResponseSchema,
	skjaldConnectExchangeBodySchema,
	skjaldConnectExchangeResponseSchema,
} from '@maskin/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	CONNECT_CODE_TTL_MS,
	type SkjaldConnectGrant,
	connectRedirectUrl,
	createRateLimiter,
	generateSigningSecret,
	hashConnectCode,
	isAllowedSkjaldRedirectUri,
	isGrantLive,
	mintConnectCode,
	readGrant,
	verifyPkce,
} from '../lib/integrations/providers/skjald/connect'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import type { IntegrationConfig } from '../lib/types'
import { resolvePublicOrigin } from './integrations'

// "Connect with Maskin" from the Skjald app, see lib/integrations/providers/skjald/connect.ts. Mounted before the
// generic /api/integrations routes, like the other providers that have their own.

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const PROVIDER = 'skjald'
/** 30 tries a minute from one address is far more than the app ever makes and far less than a guesser needs. */
const allowExchange = createRateLimiter(30, 60_000)

// ── POST /api/integrations/skjald/authorize ──────────────────────────

const authorizeRoute = createRoute({
	method: 'post',
	path: '/authorize',
	tags: ['integrations'],
	summary: 'Approve the Skjald app for this workspace and mint a one-time connect code',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: skjaldConnectAuthorizeBodySchema } } },
	},
	responses: {
		200: {
			description: 'Where to send the browser: the Skjald app with a one-time code',
			content: { 'application/json': { schema: skjaldConnectAuthorizeResponseSchema } },
		},
		400: { description: 'Error', content: { 'application/json': { schema: errorSchema } } },
		500: { description: 'Server error', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(authorizeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	if (!isAllowedSkjaldRedirectUri(body.redirect_uri)) {
		return c.json(createApiError('BAD_REQUEST', 'redirect_uri is not allowed'), 400)
	}

	const [workspace] = await db
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return c.json(createApiError('BAD_REQUEST', 'Workspace not found'), 400)

	const systemActorId = await ensureSkjaldSystemActor(db, workspaceId, actorId)

	// Connecting again from the same workspace reuses its Skjald integration (and gives it a new secret when the code
	// is exchanged) instead of adding another row every time.
	const [existing] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, PROVIDER),
				inArray(integrations.status, ['active', 'awaiting_secret']),
			),
		)
		.orderBy(desc(integrations.createdAt))
		.limit(1)

	const token = existing?.externalId ?? randomBytes(24).toString('hex')
	const webhookUrl = `${resolvePublicOrigin(c.req.url, c.req.header())}/api/webhooks/${PROVIDER}/${token}`
	const { code, codeHash } = mintConnectCode()
	const grant: SkjaldConnectGrant = {
		code_hash: codeHash,
		code_challenge: body.code_challenge,
		expires_at: new Date(Date.now() + CONNECT_CODE_TTL_MS).toISOString(),
		secret_enc: encrypt(generateSigningSecret()),
		webhook_url: webhookUrl,
		workspace_name: workspace.name,
	}

	if (existing) {
		const config = {
			...(existing.config as IntegrationConfig),
			system_actor_id: systemActorId,
			skjald_connect: grant,
		}
		await db
			.update(integrations)
			.set({ config, externalId: token, updatedAt: new Date() })
			.where(eq(integrations.id, existing.id))
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: existing.id,
			data: { provider: PROVIDER, via: 'skjald_connect' },
		})
	} else {
		const config: IntegrationConfig = { system_actor_id: systemActorId, skjald_connect: grant }
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: PROVIDER,
				status: 'awaiting_secret',
				externalId: token,
				credentials: '',
				config,
				createdBy: actorId,
			})
			.returning({ id: integrations.id })
		if (!row) return c.json(createApiError('INTERNAL_ERROR', 'Failed to create integration'), 500)
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: PROVIDER, auth_type: 'manual', via: 'skjald_connect' },
		})
	}

	return c.json(
		{ redirect_url: connectRedirectUrl(code, body.state), workspace_name: workspace.name },
		200,
	)
})

// ── POST /api/integrations/skjald/exchange (no API key: the Skjald app has none) ──

const exchangeRoute = createRoute({
	method: 'post',
	path: '/exchange',
	tags: ['integrations'],
	summary: 'Trade the one-time connect code for the webhook URL and signing secret',
	request: {
		body: { content: { 'application/json': { schema: skjaldConnectExchangeBodySchema } } },
	},
	responses: {
		200: {
			description: 'The webhook URL and signing secret, once',
			content: { 'application/json': { schema: skjaldConnectExchangeResponseSchema } },
		},
		404: {
			description: 'Unknown, expired or used code',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Too many tries',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const NOT_FOUND = createApiError('NOT_FOUND', 'This connection link is not valid any more')

app.openapi(exchangeRoute, async (c) => {
	const db = c.get('db')
	const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
	if (!allowExchange(ip)) return c.json(createApiError('RATE_LIMITED', 'Too many tries'), 429)

	const { code, code_verifier: verifier } = c.req.valid('json')
	const codeHash = hashConnectCode(code)

	const [row] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, PROVIDER),
				sql`${integrations.config} -> 'skjald_connect' ->> 'code_hash' = ${codeHash}`,
			),
		)
		.limit(1)
	const grant = row ? readGrant(row.config) : null
	// Unknown, expired and wrong verifier all look the same from outside.
	if (!row || !grant || !isGrantLive(grant) || !verifyPkce(verifier, grant.code_challenge)) {
		return c.json(NOT_FOUND, 404)
	}

	// Single use: the grant is removed in the same statement that activates the integration, and only if it is still
	// there, so two exchanges of one code cannot both succeed.
	const { skjald_connect: _used, ...rest } = row.config as IntegrationConfig
	const secret = decrypt(grant.secret_enc)
	const claimed = await db
		.update(integrations)
		.set({ credentials: encrypt(secret), status: 'active', config: rest, updatedAt: new Date() })
		.where(
			and(
				eq(integrations.id, row.id),
				sql`${integrations.config} -> 'skjald_connect' ->> 'code_hash' = ${codeHash}`,
			),
		)
		.returning({ id: integrations.id })
	if (claimed.length === 0) return c.json(NOT_FOUND, 404)

	await recordEvent(db, {
		workspaceId: row.workspaceId,
		actorId: row.createdBy,
		action: 'updated',
		entityType: 'integration',
		entityId: row.id,
		data: { provider: PROVIDER, via: 'skjald_connect' },
	})
	logger.info('Skjald connected through one-click connect', { integrationId: row.id })

	return c.json(
		{ webhook_url: grant.webhook_url, secret, workspace_name: grant.workspace_name },
		200,
	)
})

/** The system actor Skjald's events are written as, added to the workspace (same as the manual /connect). */
async function ensureSkjaldSystemActor(
	db: Database,
	workspaceId: string,
	createdBy: string,
): Promise<string> {
	const name = 'Skjald'
	let [systemActor] = await db
		.select()
		.from(actors)
		.where(and(eq(actors.type, 'system'), eq(actors.name, name)))
		.limit(1)
	if (!systemActor) {
		;[systemActor] = await db
			.insert(actors)
			.values({ type: 'system', name, apiKey: generateApiKey().key, createdBy })
			.returning()
	}
	if (!systemActor) throw new Error('Failed to create system actor for integration')

	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, systemActor.id),
			),
		)
		.limit(1)
	if (!member) {
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: systemActor.id, role: 'system' })
	}
	return systemActor.id
}

export default app
