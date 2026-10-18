import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	blockedToolCalls,
	extensions,
	webhookDeliveries,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	type ToolGrants,
	createExtensionBodySchema,
	mcpConfigSchema,
	setAgentGrantBodySchema,
	setToolGrantBodySchema,
	toolGrantsSchema,
	updateExtensionBodySchema,
	webhookConfigSchema,
} from '@maskin/shared'
import { and, desc, eq, gt, isNotNull, like, max, sql } from 'drizzle-orm'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	defaultToolGrants,
	extensionProvider,
	generateSigningSecret,
	generateWebhookToken,
	mapWebhookEvent,
	mcpConfigWriteError,
} from '../lib/integrations/extensions'
import {
	ensureExtensionSystemActor,
	hasExtensionSecret,
	upsertExtensionSecret,
} from '../lib/integrations/extensions-db'
import { VENDOR_RECIPES } from '../lib/integrations/vendor-recipes'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { resolvePublicOrigin } from './integrations'

// Custom (bring-your-own) extensions: create, read and update the workspace's
// own webhook / MCP integrations. Writes are for workspace owners and admins.
// The signing secret goes in encrypted (integrations, provider
// 'extension:{slug}') and is never returned by any route here, except the
// one-off value minted by POST /generate-secret that the caller copies into
// the vendor.

type Env = {
	Variables: {
		db: Database
		actorId: string
		/** Caller's role in the X-Workspace-Id workspace, set by authMiddleware. */
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** Deliveries newer than this count as "live" and appear in history (ruling R7, R8). */
const DELIVERY_WINDOW_DAYS = 14
const DELIVERY_PAGE_SIZE = 50

type ExtensionRow = typeof extensions.$inferSelect

const hasConfig = (row: Pick<ExtensionRow, 'mcpConfig' | 'webhookConfig'>) =>
	!!(row.mcpConfig || row.webhookConfig)

/**
 * Fire the built-in integration_connected event for an extension. Called after
 * the database commit; best-effort, never throws. The provider is the same
 * 'extension:{slug}' string the extension's integrations row carries.
 */
function trackExtensionConnected(workspaceId: string, actorId: string, row: ExtensionRow) {
	void trackIntegrationConnected({
		provider: extensionProvider(row.slug),
		workspaceId,
		actorId,
		integrationId: row.id,
	})
}

const extensionResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	slug: z.string(),
	name: z.string(),
	status: z.enum(['active', 'disabled', 'draft']),
	mcpConfig: z.record(z.string(), z.unknown()).nullable(),
	webhookConfig: z.record(z.string(), z.unknown()).nullable(),
	webhookToken: z.string().nullable(),
	webhookUrl: z.string().nullable(),
	/** True when a signing secret is stored. The secret itself is never returned. */
	hasSigningSecret: z.boolean(),
	toolGrants: z.record(z.string(), z.unknown()),
	mcpLastError: z.string().nullable(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/** Most recent committed delivery inside the last 14 days, or null. */
	lastDeliveryAt: z.string().nullable(),
	committedDeliveries: z.number().int(),
})

type ExtensionResponse = z.infer<typeof extensionResponseSchema>

function isOwnerOrAdmin(role: string | undefined): boolean {
	return role === 'owner' || role === 'admin'
}

function forbidden() {
	return createApiError('FORBIDDEN', 'Only a workspace owner or admin can change extensions')
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
	// Drizzle wraps the driver's PostgresError as `err.cause`; walk the chain.
	for (let current: unknown = err; current && typeof current === 'object'; ) {
		const e = current as {
			code?: string
			constraint_name?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			if (e.constraint_name === constraintName) return true
			if (typeof e.message === 'string' && e.message.includes(constraintName)) return true
		}
		current = e.cause
	}
	return false
}

function windowStart(): Date {
	return new Date(Date.now() - DELIVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
}

type DeliveryStats = { lastDeliveryAt: Date | null; committed: number }

/** Committed deliveries per extension provider slug over the last 14 days. */
async function deliveryStats(
	db: Database,
	workspaceId: string,
	slug?: string,
): Promise<Map<string, DeliveryStats>> {
	const rows = await db
		.select({
			provider: webhookDeliveries.provider,
			last: sql<Date | null>`max(${webhookDeliveries.processedAt})`,
			committed: sql<number>`count(*)::int`,
		})
		.from(webhookDeliveries)
		.where(
			and(
				eq(webhookDeliveries.workspaceId, workspaceId),
				slug
					? eq(webhookDeliveries.provider, extensionProvider(slug))
					: like(webhookDeliveries.provider, 'extension:%'),
				isNotNull(webhookDeliveries.processedAt),
				gt(webhookDeliveries.receivedAt, windowStart()),
			),
		)
		.groupBy(webhookDeliveries.provider)
	const out = new Map<string, DeliveryStats>()
	for (const r of rows) {
		out.set(r.provider, {
			lastDeliveryAt: r.last ? new Date(r.last) : null,
			committed: Number(r.committed),
		})
	}
	return out
}

function toResponse(
	row: ExtensionRow,
	extra: { origin: string; hasSigningSecret: boolean; stats?: DeliveryStats },
): ExtensionResponse {
	const base = serialize(row)
	return {
		id: base.id,
		workspaceId: base.workspaceId,
		slug: base.slug,
		name: base.name,
		status: base.status,
		mcpConfig: base.mcpConfig ?? null,
		webhookConfig: base.webhookConfig ?? null,
		webhookToken: base.webhookToken,
		webhookUrl: base.webhookToken ? `${extra.origin}/api/webhooks/x/${base.webhookToken}` : null,
		hasSigningSecret: extra.hasSigningSecret,
		toolGrants: base.toolGrants as Record<string, unknown>,
		mcpLastError: base.mcpLastError,
		createdBy: base.createdBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastDeliveryAt: extra.stats?.lastDeliveryAt?.toISOString() ?? null,
		committedDeliveries: extra.stats?.committed ?? 0,
	}
}

async function loadOne(db: Database, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(extensions)
		.where(and(eq(extensions.id, id), eq(extensions.workspaceId, workspaceId)))
		.limit(1)
	return row ?? null
}

async function respond(
	c: { req: { url: string; header: () => Record<string, string> } },
	db: Database,
	row: ExtensionRow,
): Promise<ExtensionResponse> {
	const [hasSecret, stats] = await Promise.all([
		hasExtensionSecret(db, row.workspaceId, row.slug),
		deliveryStats(db, row.workspaceId, row.slug),
	])
	return toResponse(row, {
		origin: resolvePublicOrigin(c.req.url, c.req.header()),
		hasSigningSecret: hasSecret,
		stats: stats.get(extensionProvider(row.slug)),
	})
}

const notFound = createApiError('NOT_FOUND', 'Extension not found')

// ── GET /api/extensions ─────────────────────────────────────────────────────

const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['extensions'],
	summary: "List the workspace's custom extensions",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Extensions, newest first',
			content: { 'application/json': { schema: z.array(extensionResponseSchema) } },
		},
	},
})

app.openapi(listRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const rows = await db
		.select()
		.from(extensions)
		.where(eq(extensions.workspaceId, workspaceId))
		.orderBy(desc(extensions.createdAt))
	const [stats, secretRows] = await Promise.all([
		deliveryStats(db, workspaceId),
		Promise.all(rows.map((r) => hasExtensionSecret(db, workspaceId, r.slug))),
	])
	const origin = resolvePublicOrigin(c.req.url, c.req.header())
	return c.json(
		rows.map((r, i) =>
			toResponse(r, {
				origin,
				hasSigningSecret: secretRows[i] ?? false,
				stats: stats.get(extensionProvider(r.slug)),
			}),
		),
		200,
	)
})

// ── GET /api/extensions/recipes ─────────────────────────────────────────────

const recipesRoute = createRoute({
	method: 'get',
	path: '/recipes',
	tags: ['extensions'],
	summary: 'Vendor recipes that pre-fill the extension forms ("Start from a recipe")',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Hardcoded recipes, pre-fill only',
			content: {
				'application/json': {
					schema: z.array(
						z.object({
							slug: z.string(),
							displayName: z.string(),
							webhookConfig: z.record(z.string(), z.unknown()).optional(),
							docsUrl: z.string(),
						}),
					),
				},
			},
		},
	},
})

app.openapi(recipesRoute, async (c) => {
	return c.json(
		VENDOR_RECIPES.map((r) => ({
			slug: r.slug,
			displayName: r.displayName,
			webhookConfig: r.webhookConfig,
			docsUrl: r.docsUrl,
		})),
		200,
	)
})

// ── POST /api/extensions/generate-secret ────────────────────────────────────

const generateSecretRoute = createRoute({
	method: 'post',
	path: '/generate-secret',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary:
		'Mint a signing secret (32 random bytes, hex) to paste into the vendor. Nothing is stored.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'A fresh secret, shown once',
			content: { 'application/json': { schema: z.object({ secret: z.string() }) } },
		},
		403: { description: 'Not an owner', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(generateSecretRoute, async (c) => {
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)
	return c.json({ secret: generateSigningSecret() }, 200)
})

// ── POST /api/extensions ────────────────────────────────────────────────────

const createExtensionRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary: 'Create a custom extension',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createExtensionBodySchema } } },
	},
	responses: {
		201: {
			description: 'Created',
			content: { 'application/json': { schema: extensionResponseSchema } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not an owner', content: { 'application/json': { schema: errorSchema } } },
		409: { description: 'Slug taken', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(createExtensionRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)
	const body = c.req.valid('json')

	const mcpError = mcpConfigWriteError(body.mcp_config)
	if (mcpError) {
		return c.json(
			createApiError('BAD_REQUEST', mcpError, [{ field: 'mcp_config', message: mcpError }]),
			400,
		)
	}

	// Ruling R2: no unsigned webhooks.
	if (body.webhook_config && !body.signing_secret) {
		return c.json(
			createApiError('BAD_REQUEST', 'A webhook needs a signing secret', [
				{ field: 'signing_secret', message: 'Required when webhook_config is set' },
			]),
			400,
		)
	}

	const webhookToken = body.webhook_config ? generateWebhookToken() : null

	let row: ExtensionRow
	try {
		row = await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(extensions)
				.values({
					workspaceId,
					slug: body.slug,
					name: body.name,
					status: body.status ?? 'active',
					mcpConfig: body.mcp_config ?? null,
					webhookConfig: body.webhook_config ?? null,
					webhookToken,
					createdBy: actorId,
				})
				.returning()
			if (!created) throw new Error('Failed to create extension')
			if (body.signing_secret) {
				await upsertExtensionSecret(tx, {
					workspaceId,
					slug: body.slug,
					secret: body.signing_secret,
					createdBy: actorId,
				})
			}
			// The generic route attributes events to this actor.
			await ensureExtensionSystemActor(tx, workspaceId, actorId)
			return created
		})
	} catch (err) {
		if (isUniqueViolation(err, 'extensions_workspace_slug_uniq')) {
			return c.json(createApiError('CONFLICT', 'An extension with this slug already exists'), 409)
		}
		throw err
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'extension',
		entityId: row.id,
		data: {
			slug: row.slug,
			has_webhook: !!row.webhookConfig,
			has_mcp: !!row.mcpConfig,
		},
	})

	if (hasConfig(row)) trackExtensionConnected(workspaceId, actorId, row)

	return c.json(await respond(c, db, row), 201)
})

// ── GET /api/extensions/:id ─────────────────────────────────────────────────

const getRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['extensions'],
	summary: 'Get a custom extension (never includes the signing secret)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'The extension',
			content: { 'application/json': { schema: extensionResponseSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const row = await loadOne(db, workspaceId, id)
	if (!row) return c.json(notFound, 404)
	return c.json(await respond(c, db, row), 200)
})

// ── PATCH /api/extensions/:id ───────────────────────────────────────────────

const updateExtensionRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary:
		'Update a custom extension. The slug cannot change; a new signing_secret replaces the old one.',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateExtensionBodySchema } } },
	},
	responses: {
		200: {
			description: 'Updated',
			content: { 'application/json': { schema: extensionResponseSchema } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not an owner', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(updateExtensionRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)
	const body = c.req.valid('json')

	const existing = await loadOne(db, workspaceId, id)
	if (!existing) return c.json(notFound, 404)

	const mcpError = mcpConfigWriteError(body.mcp_config)
	if (mcpError) {
		return c.json(
			createApiError('BAD_REQUEST', mcpError, [{ field: 'mcp_config', message: mcpError }]),
			400,
		)
	}

	// A webhook config must end up with a stored secret (ruling R2).
	const nextWebhook =
		body.webhook_config === undefined ? existing.webhookConfig : body.webhook_config
	if (
		nextWebhook &&
		!body.signing_secret &&
		!(await hasExtensionSecret(db, workspaceId, existing.slug))
	) {
		return c.json(
			createApiError('BAD_REQUEST', 'A webhook needs a signing secret', [
				{ field: 'signing_secret', message: 'Required when webhook_config is set' },
			]),
			400,
		)
	}

	const patch: Partial<typeof extensions.$inferInsert> = { updatedAt: new Date() }
	if (body.name !== undefined) patch.name = body.name
	if (body.status !== undefined) patch.status = body.status
	if (body.mcp_config !== undefined) patch.mcpConfig = body.mcp_config
	if (body.webhook_config !== undefined) {
		patch.webhookConfig = body.webhook_config
		// Turning the webhook off retires its URL; turning it on mints one.
		if (body.webhook_config === null) patch.webhookToken = null
		else if (!existing.webhookToken) patch.webhookToken = generateWebhookToken()
	}

	const row = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(extensions)
			.set(patch)
			.where(and(eq(extensions.id, id), eq(extensions.workspaceId, workspaceId)))
			.returning()
		if (!updated) throw new Error('Failed to update extension')
		if (body.signing_secret) {
			await upsertExtensionSecret(tx, {
				workspaceId,
				slug: existing.slug,
				secret: body.signing_secret,
				createdBy: actorId,
			})
		}
		return updated
	})

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'extension',
		entityId: row.id,
		data: {
			slug: row.slug,
			fields: Object.keys(body).filter((k) => k !== 'signing_secret'),
			secret_replaced: !!body.signing_secret,
		},
	})

	// Only the save that first gives the extension a config counts as connecting it.
	if (!hasConfig(existing) && hasConfig(row)) trackExtensionConnected(workspaceId, actorId, row)

	return c.json(await respond(c, db, row), 200)
})

// ── POST /api/extensions/:id/regenerate-token ───────────────────────────────

const regenerateTokenRoute = createRoute({
	method: 'post',
	path: '/{id}/regenerate-token',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary: 'Mint a new webhook token. The old URL stops working immediately (404).',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'The extension with its new webhook URL',
			content: { 'application/json': { schema: extensionResponseSchema } },
		},
		400: { description: 'No webhook', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not an owner', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(regenerateTokenRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)

	const existing = await loadOne(db, workspaceId, id)
	if (!existing) return c.json(notFound, 404)
	if (!existing.webhookConfig) {
		return c.json(createApiError('BAD_REQUEST', 'This extension has no webhook'), 400)
	}

	const [row] = await db
		.update(extensions)
		.set({ webhookToken: generateWebhookToken(), updatedAt: new Date() })
		.where(and(eq(extensions.id, id), eq(extensions.workspaceId, workspaceId)))
		.returning()
	if (!row) return c.json(notFound, 404)

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'extension',
		entityId: row.id,
		data: { slug: row.slug, fields: ['webhook_token'] },
	})

	return c.json(await respond(c, db, row), 200)
})

// ── GET /api/extensions/:id/deliveries ──────────────────────────────────────

const deliveriesRoute = createRoute({
	method: 'get',
	path: '/{id}/deliveries',
	tags: ['extensions'],
	summary: 'Committed deliveries from the last 14 days (the idempotency ledger)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Newest first, at most 50',
			content: {
				'application/json': {
					schema: z.object({
						windowDays: z.number().int(),
						committed: z.number().int(),
						deliveries: z.array(
							z.object({
								id: z.string().uuid(),
								externalId: z.string(),
								receivedAt: z.string(),
								processedAt: z.string(),
							}),
						),
					}),
				},
			},
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(deliveriesRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const ext = await loadOne(db, workspaceId, id)
	if (!ext) return c.json(notFound, 404)

	const where = and(
		eq(webhookDeliveries.workspaceId, workspaceId),
		eq(webhookDeliveries.provider, extensionProvider(ext.slug)),
		isNotNull(webhookDeliveries.processedAt),
		gt(webhookDeliveries.receivedAt, windowStart()),
	)
	const [rows, stats] = await Promise.all([
		db
			.select()
			.from(webhookDeliveries)
			.where(where)
			.orderBy(desc(webhookDeliveries.receivedAt))
			.limit(DELIVERY_PAGE_SIZE),
		deliveryStats(db, workspaceId, ext.slug),
	])
	return c.json(
		{
			windowDays: DELIVERY_WINDOW_DAYS,
			committed: stats.get(extensionProvider(ext.slug))?.committed ?? 0,
			deliveries: rows.map((r) => ({
				id: r.id,
				externalId: r.externalId,
				receivedAt: r.receivedAt.toISOString(),
				processedAt: (r.processedAt ?? r.receivedAt).toISOString(),
			})),
		},
		200,
	)
})

// ── POST /api/extensions/:id/sample ─────────────────────────────────────────

const sampleBodySchema = z.object({
	/** Raw JSON text of a sample delivery body. */
	payload: z.string().min(1).max(256_000),
	/** Unsaved webhook config from the form; falls back to the stored one. */
	webhook_config: webhookConfigSchema.optional(),
})

const sampleRoute = createRoute({
	method: 'post',
	path: '/{id}/sample',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary: 'Dry run: show the event a sample payload would produce. Writes nothing.',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: sampleBodySchema } } },
	},
	responses: {
		200: {
			description: 'The mapped event, or the first field that did not resolve',
			content: {
				'application/json': {
					schema: z.discriminatedUnion('ok', [
						z.object({
							ok: z.literal(true),
							event: z.object({
								externalId: z.string(),
								entityType: z.string(),
								action: z.string(),
								data: z.unknown(),
							}),
						}),
						z.object({ ok: z.literal(false), field: z.string(), message: z.string() }),
					]),
				},
			},
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not an owner', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(sampleRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)
	const body = c.req.valid('json')

	const ext = await loadOne(db, workspaceId, id)
	if (!ext) return c.json(notFound, 404)

	const config = body.webhook_config ?? ext.webhookConfig
	if (!config) {
		return c.json(createApiError('BAD_REQUEST', 'This extension has no webhook config'), 400)
	}

	let payload: unknown
	try {
		payload = JSON.parse(body.payload)
	} catch {
		return c.json(
			{ ok: false as const, field: 'payload', message: 'The sample is not valid JSON' },
			200,
		)
	}

	const result = mapWebhookEvent(config.eventMap, payload)
	return c.json(result, 200)
})

// ── Tool grants ─────────────────────────────────────────────────────────────
// Per-agent, per-tool access to a custom extension's MCP tools (tech spec
// section 5). An agent with no entry is denied every tool. Granting writes the
// declared tools' defaults (read allow, write deny) in full, then applies the
// owner's explicit choices on top. Built-in integrations have no row in this
// table, so none of these routes can reach them.

/** Attempted-tool signal looks back this far (matches blocked_tool_calls retention). */
const ATTEMPTED_WINDOW_DAYS = 30

const agentIdParamSchema = z.object({
	id: z.string().uuid(),
	agentId: z.string().uuid(),
})

const toolParamSchema = agentIdParamSchema.extend({ toolName: z.string().min(1).max(256) })

const declaredToolSchema = z.object({
	name: z.string(),
	kind: z.enum(['read', 'write']),
	description: z.string().optional(),
})

const grantsResponseSchema = z.object({
	/** agentId -> toolName -> grant, exactly as stored. */
	toolGrants: z.record(z.string(), z.unknown()),
	/** The tools mcp_config declares, with the kind that drives the grant defaults. */
	tools: z.array(declaredToolSchema),
})

type GrantsResponse = z.infer<typeof grantsResponseSchema>

function declaredTools(row: Pick<ExtensionRow, 'mcpConfig'>): z.infer<typeof declaredToolSchema>[] {
	const parsed = mcpConfigSchema.shape.tools.safeParse(
		(row.mcpConfig as { tools?: unknown } | null)?.tools ?? [],
	)
	return parsed.success ? parsed.data : []
}

function storedGrants(row: Pick<ExtensionRow, 'toolGrants'>): ToolGrants {
	const parsed = toolGrantsSchema.safeParse(row.toolGrants ?? {})
	return parsed.success ? parsed.data : {}
}

function grantsResponse(row: ExtensionRow): GrantsResponse {
	return { toolGrants: storedGrants(row), tools: declaredTools(row) }
}

const notAnAgent = createApiError('BAD_REQUEST', 'Only an agent in this workspace can be granted')

/** True when the actor is an agent that belongs to the workspace. */
async function isWorkspaceAgent(
	db: Database,
	workspaceId: string,
	agentId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(
			workspaceMembers,
			and(eq(workspaceMembers.actorId, actors.id), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.where(and(eq(actors.id, agentId), eq(actors.type, 'agent')))
		.limit(1)
	return !!row
}

type GrantChange = (
	current: ToolGrants,
	tools: ReturnType<typeof declaredTools>,
) => ToolGrants | string

/**
 * Read-modify-write on the grants column under a row lock, so two owners
 * flipping different tools at once cannot overwrite each other. A string
 * returned by `change` is a validation message and nothing is written.
 */
async function writeGrants(
	db: Database,
	args: { workspaceId: string; id: string; actorId: string; agentId: string; change: GrantChange },
): Promise<
	{ ok: true; row: ExtensionRow } | { ok: false; reason: 'not_found' | 'invalid'; message?: string }
> {
	const { workspaceId, id, actorId, agentId, change } = args
	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(extensions)
			.where(and(eq(extensions.id, id), eq(extensions.workspaceId, workspaceId)))
			.for('update')
			.limit(1)
		if (!locked) return { ok: false as const, reason: 'not_found' as const }

		const next = change(storedGrants(locked), declaredTools(locked))
		if (typeof next === 'string') {
			return { ok: false as const, reason: 'invalid' as const, message: next }
		}
		const [updated] = await tx
			.update(extensions)
			.set({ toolGrants: next, updatedAt: new Date() })
			.where(eq(extensions.id, id))
			.returning()
		if (!updated) throw new Error('Failed to update extension grants')
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'extension',
			entityId: id,
			data: { slug: updated.slug, fields: ['tool_grants'], agent_id: agentId },
		})
		return { ok: true as const, row: updated }
	})
	return result
}

const getGrantsRoute = createRoute({
	method: 'get',
	path: '/{id}/grants',
	tags: ['extensions'],
	summary: "Read the extension's tool grants and the tools they apply to",
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Stored grants and declared tools',
			content: { 'application/json': { schema: grantsResponseSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getGrantsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const row = await loadOne(db, workspaceId, id)
	if (!row) return c.json(notFound, 404)
	return c.json(grantsResponse(row), 200)
})

const grantsFailureResponses = {
	400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not an owner', content: { 'application/json': { schema: errorSchema } } },
	404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
}

const setAgentGrantRoute = createRoute({
	method: 'put',
	path: '/{id}/grants/{agentId}',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary:
		'Grant an agent access. Each declared tool starts from its default (read allow, write deny); tools in the body override that. Replaces any earlier entry for the agent.',
	request: {
		headers: workspaceIdHeader,
		params: agentIdParamSchema,
		body: { content: { 'application/json': { schema: setAgentGrantBodySchema } } },
	},
	responses: {
		200: {
			description: 'Grants after the change',
			content: { 'application/json': { schema: grantsResponseSchema } },
		},
		...grantsFailureResponses,
	},
})

app.openapi(setAgentGrantRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, agentId } = c.req.valid('param')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)
	const body = c.req.valid('json')

	if (!(await isWorkspaceAgent(db, workspaceId, agentId))) {
		return c.json(notAnAgent, 400)
	}

	const result = await writeGrants(db, {
		workspaceId,
		id,
		actorId,
		agentId,
		change: (current, tools) => {
			if (tools.length === 0) {
				return 'This extension declares no tools yet, so there is nothing to grant'
			}
			const names = new Set(tools.map((t) => t.name))
			const unknown = Object.keys(body.tools ?? {}).find((name) => !names.has(name))
			if (unknown) return `Tool ${unknown} is not declared by this extension`
			return { ...current, [agentId]: { ...defaultToolGrants(tools), ...(body.tools ?? {}) } }
		},
	})
	if (!result.ok) {
		return result.reason === 'not_found'
			? c.json(notFound, 404)
			: c.json(createApiError('BAD_REQUEST', result.message ?? 'Invalid grant'), 400)
	}
	return c.json(grantsResponse(result.row), 200)
})

const setToolGrantRoute = createRoute({
	method: 'put',
	path: '/{id}/grants/{agentId}/tools/{toolName}',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary:
		'Flip one tool for one agent. Touches only that tool; an agent with no entry gets an entry holding just this tool.',
	request: {
		headers: workspaceIdHeader,
		params: toolParamSchema,
		body: { content: { 'application/json': { schema: setToolGrantBodySchema } } },
	},
	responses: {
		200: {
			description: 'Grants after the change',
			content: { 'application/json': { schema: grantsResponseSchema } },
		},
		...grantsFailureResponses,
	},
})

app.openapi(setToolGrantRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, agentId, toolName } = c.req.valid('param')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)
	const { effect } = c.req.valid('json')

	if (!(await isWorkspaceAgent(db, workspaceId, agentId))) {
		return c.json(notAnAgent, 400)
	}

	const result = await writeGrants(db, {
		workspaceId,
		id,
		actorId,
		agentId,
		change: (current, tools) => {
			if (!tools.some((t) => t.name === toolName)) {
				return `Tool ${toolName} is not declared by this extension`
			}
			return { ...current, [agentId]: { ...(current[agentId] ?? {}), [toolName]: effect } }
		},
	})
	if (!result.ok) {
		return result.reason === 'not_found'
			? c.json(notFound, 404)
			: c.json(createApiError('BAD_REQUEST', result.message ?? 'Invalid grant'), 400)
	}
	return c.json(grantsResponse(result.row), 200)
})

const revokeAgentGrantRoute = createRoute({
	method: 'delete',
	path: '/{id}/grants/{agentId}',
	'x-viewer-policy': 'writer',
	tags: ['extensions'],
	summary: "Remove an agent's entry, which denies it every tool again",
	request: { headers: workspaceIdHeader, params: agentIdParamSchema },
	responses: {
		200: {
			description: 'Grants after the change',
			content: { 'application/json': { schema: grantsResponseSchema } },
		},
		403: grantsFailureResponses[403],
		404: grantsFailureResponses[404],
	},
})

app.openapi(revokeAgentGrantRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, agentId } = c.req.valid('param')
	if (!isOwnerOrAdmin(c.get('workspaceRole'))) return c.json(forbidden(), 403)

	const result = await writeGrants(db, {
		workspaceId,
		id,
		actorId,
		agentId,
		change: (current) => {
			const { [agentId]: _removed, ...rest } = current
			return rest
		},
	})
	if (!result.ok) return c.json(notFound, 404)
	return c.json(grantsResponse(result.row), 200)
})

const attemptedRoute = createRoute({
	method: 'get',
	path: '/{id}/attempted',
	tags: ['extensions'],
	summary: 'Tools each agent tried to call and was refused, over the last 30 days',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'Distinct refused tool names per agent, from blocked_tool_calls',
			content: {
				'application/json': {
					schema: z.object({
						windowDays: z.number().int(),
						agents: z.array(
							z.object({
								agentId: z.string().uuid(),
								tools: z.array(z.string()),
								lastAttemptedAt: z.string(),
							}),
						),
					}),
				},
			},
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(attemptedRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const ext = await loadOne(db, workspaceId, id)
	if (!ext) return c.json(notFound, 404)

	const since = new Date(Date.now() - ATTEMPTED_WINDOW_DAYS * 24 * 60 * 60 * 1000)
	const rows = await db
		.select({
			agentId: blockedToolCalls.agentId,
			toolName: blockedToolCalls.toolName,
			last: max(blockedToolCalls.blockedAt),
		})
		.from(blockedToolCalls)
		.where(
			and(
				eq(blockedToolCalls.workspaceId, workspaceId),
				eq(blockedToolCalls.extensionId, id),
				gt(blockedToolCalls.blockedAt, since),
			),
		)
		.groupBy(blockedToolCalls.agentId, blockedToolCalls.toolName)

	const byAgent = new Map<string, { tools: string[]; last: Date }>()
	for (const r of rows) {
		const last = r.last ? new Date(r.last) : since
		const entry = byAgent.get(r.agentId) ?? { tools: [], last }
		entry.tools.push(r.toolName)
		if (last > entry.last) entry.last = last
		byAgent.set(r.agentId, entry)
	}
	return c.json(
		{
			windowDays: ATTEMPTED_WINDOW_DAYS,
			agents: [...byAgent.entries()].map(([agentId, v]) => ({
				agentId,
				tools: v.tools.sort(),
				lastAttemptedAt: v.last.toISOString(),
			})),
		},
		200,
	)
})

export default app
