import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceToolBrokers } from '@maskin/db'
import { ToolBrokerUnavailableError } from '@maskin/tool-broker'
import { eq } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { ensureProvisioned, getToolBrokerClient } from '../lib/tool-broker/provisioning'

// ---------------------------------------------------------------------------
// Workspace-facing tool broker API.
//
// Workspace comes from `X-Workspace-Id`, so membership is already enforced by
// `authMiddleware` before any handler runs — no `isWorkspaceMember` call needed
// here (see CLAUDE.md's reviewer note on header-scoped routes).
//
// Every handler degrades rather than failing when the backend is unreachable:
// an integrations outage must not take out the settings page.
// ---------------------------------------------------------------------------

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const integrationSchema = z.object({
	slug: z.string(),
	name: z.string(),
	kind: z.enum(['mcp', 'openapi']),
	removable: z.boolean(),
	url: z.string().nullable(),
	connected: z.boolean(),
})

const listResponseSchema = z.object({
	configured: z.boolean().openapi({ description: 'False when the backend is not configured.' }),
	available: z.boolean().openapi({ description: 'False when the backend is unreachable.' }),
	integrations: z.array(integrationSchema),
})

/**
 * Validate a user-supplied integration URL.
 *
 * External input at a system boundary, and the value is handed to a backend
 * that will fetch it — so this rejects rather than normalises. `http` is allowed
 * only for loopback, which is what makes local development possible without
 * opening the door to plaintext fetches of arbitrary hosts.
 */
const parseIntegrationUrl = (raw: string): URL | null => {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	if (url.username || url.password) return null
	if (url.protocol === 'https:') return url
	if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
		return url
	}
	return null
}

const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Tool Broker'],
	summary: 'Integrations available to this workspace through the tool broker',
	responses: {
		200: {
			description: 'Integrations',
			content: { 'application/json': { schema: listResponseSchema } },
		},
	},
})

app.openapi(listRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ configured: false, available: false, integrations: [] }, 200)
	if (!getToolBrokerClient()) {
		// Not configured is a normal state, not an error: the UI renders an empty
		// section rather than a failure.
		return c.json({ configured: false, available: false, integrations: [] }, 200)
	}

	try {
		const provisioned = await ensureProvisioned(c.get('db'), {
			workspaceId,
			actorId: c.get('actorId'),
		})
		if (!provisioned) return c.json({ configured: false, available: false, integrations: [] }, 200)

		const [integrations, connections] = await Promise.all([
			provisioned.client.listIntegrations(provisioned.apiKey, workspaceId),
			provisioned.client.listConnections(provisioned.apiKey, workspaceId),
		])
		const connectedSlugs = new Set(connections.map((connection) => connection.integrationSlug))

		return c.json(
			{
				configured: true,
				available: true,
				integrations: integrations.map((integration) => ({
					slug: integration.slug,
					name: integration.name,
					kind: integration.kind,
					removable: integration.removable,
					url: integration.url,
					// Available to the workspace is not the same as usable: an
					// integration with no connection has no callable tools.
					connected: connectedSlugs.has(integration.slug),
				})),
			},
			200,
		)
	} catch (error) {
		if (error instanceof ToolBrokerUnavailableError) {
			logger.warn('Tool broker unreachable while listing integrations', { workspaceId })
			return c.json({ configured: true, available: false, integrations: [] }, 200)
		}
		throw error
	}
})

const addRoute = createRoute({
	method: 'post',
	path: '/integrations',
	tags: ['Tool Broker'],
	summary: 'Add an integration by URL',
	request: {
		body: {
			content: {
				'application/json': {
					schema: z.object({
						url: z.string().min(1),
						kind: z.enum(['mcp', 'openapi']),
						name: z.string().min(1).max(60).optional(),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Added',
			content: { 'application/json': { schema: z.object({ slug: z.string() }) } },
		},
		400: { description: 'Invalid URL' },
		503: { description: 'Tool broker unavailable' },
	},
})

app.openapi(addRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: { message: 'X-Workspace-Id is required' } }, 400)

	const body = c.req.valid('json')
	const url = parseIntegrationUrl(body.url)
	if (!url) {
		return c.json(
			{
				error: {
					message:
						'Provide an https URL without embedded credentials (http is allowed only for localhost).',
				},
			},
			400,
		)
	}

	const db = c.get('db')
	const actorId = c.get('actorId')
	try {
		const provisioned = await ensureProvisioned(db, { workspaceId, actorId })
		if (!provisioned) return c.json({ error: { message: 'Tool broker is not configured' } }, 503)

		const { slug } = await provisioned.client.addIntegrationByUrl(provisioned.apiKey, {
			workspaceId,
			url: url.toString(),
			kind: body.kind,
			name: body.name,
		})

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'tool_broker_integration',
			entityId: slug,
			data: { kind: body.kind, host: url.hostname },
		})

		return c.json({ slug }, 200)
	} catch (error) {
		if (error instanceof ToolBrokerUnavailableError) {
			return c.json({ error: { message: 'Tool broker is unavailable' } }, 503)
		}
		throw error
	}
})

const connectRoute = createRoute({
	method: 'post',
	path: '/integrations/{slug}/connect',
	tags: ['Tool Broker'],
	summary: 'Connect an integration and admit its tools into the workspace toolkit',
	request: {
		params: z.object({ slug: z.string() }),
		body: {
			content: {
				'application/json': {
					schema: z.object({
						auth: z.discriminatedUnion('type', [
							z.object({ type: z.literal('none') }),
							z.object({ type: z.literal('api_key'), value: z.string().min(1) }),
						]),
						scope: z.enum(['workspace', 'personal']).optional(),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Connected',
			content: { 'application/json': { schema: z.object({ address: z.string() }) } },
		},
		404: { description: 'Not provisioned' },
		503: { description: 'Tool broker unavailable' },
	},
})

app.openapi(connectRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: { message: 'X-Workspace-Id is required' } }, 400)

	const { slug } = c.req.valid('param')
	const body = c.req.valid('json')
	const db = c.get('db')
	const actorId = c.get('actorId')

	try {
		const provisioned = await ensureProvisioned(db, { workspaceId, actorId })
		if (!provisioned) return c.json({ error: { message: 'Tool broker is not configured' } }, 503)

		const connection = await provisioned.client.connect(provisioned.apiKey, {
			integrationSlug: slug,
			auth: body.auth,
			scope: body.scope,
		})

		// Connecting is what makes the tools reachable: the toolkit is
		// default-deny, so without this the connection exists and nothing can
		// call it. `admitIntegration` refuses to emit an over-broad pattern.
		await provisioned.client.admitIntegration(provisioned.apiKey, {
			toolkitId: provisioned.toolkit.toolkitId,
			integrationSlug: slug,
		})

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'tool_broker_integration',
			entityId: slug,
			data: { connected: true, scope: connection.scope },
		})

		return c.json({ address: connection.address }, 200)
	} catch (error) {
		if (error instanceof ToolBrokerUnavailableError) {
			return c.json({ error: { message: 'Tool broker is unavailable' } }, 503)
		}
		throw error
	}
})

const disconnectRoute = createRoute({
	method: 'delete',
	path: '/integrations/{slug}',
	tags: ['Tool Broker'],
	summary: 'Disconnect an integration from this workspace',
	request: {
		params: z.object({ slug: z.string() }),
		query: z.object({ scope: z.enum(['workspace', 'personal']).optional() }),
	},
	responses: {
		200: {
			description: 'Disconnected',
			content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
		},
		404: { description: 'Not provisioned' },
		503: { description: 'Tool broker unavailable' },
	},
})

app.openapi(disconnectRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: { message: 'X-Workspace-Id is required' } }, 400)

	const { slug } = c.req.valid('param')
	const { scope } = c.req.valid('query')
	const db = c.get('db')
	const actorId = c.get('actorId')

	const [provisionedRow] = await db
		.select()
		.from(workspaceToolBrokers)
		.where(eq(workspaceToolBrokers.workspaceId, workspaceId))
		.limit(1)
	if (!provisionedRow) return c.json({ error: { message: 'Not provisioned' } }, 404)

	try {
		const provisioned = await ensureProvisioned(db, { workspaceId, actorId })
		if (!provisioned) return c.json({ error: { message: 'Tool broker is not configured' } }, 503)

		await provisioned.client.disconnect(provisioned.apiKey, {
			integrationSlug: slug,
			scope: scope ?? 'workspace',
			name: scope === 'personal' ? 'personal' : 'shared',
		})

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'tool_broker_integration',
			entityId: slug,
			data: { connected: false },
		})

		return c.json({ success: true }, 200)
	} catch (error) {
		if (error instanceof ToolBrokerUnavailableError) {
			return c.json({ error: { message: 'Tool broker is unavailable' } }, 503)
		}
		throw error
	}
})

export default app
