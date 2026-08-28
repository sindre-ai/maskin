import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceToolBrokers } from '@maskin/db'
import { resolveWebAppBaseUrl } from '@maskin/shared'
import { ToolBrokerUnavailableError } from '@maskin/tool-broker'
import { eq } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { resolvePublicOrigin } from '../lib/public-origin'
import {
	OAuthNotSupportedError,
	bindOAuthFlow,
	callbackUrl,
	clearOAuthBinding,
	readOAuthBinding,
	resolveOAuthClient,
} from '../lib/tool-broker/oauth'
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
	/** How this integration can be authenticated. Drives which action the UI offers. */
	authKinds: z.array(z.enum(['none', 'api_key', 'oauth', 'other'])),
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
					authKinds: integration.authMethods.map((method) => method.kind),
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
			// entity_id is a uuid column, and an integration slug is not one — the
			// provisioning row is the closest real entity, so the slug rides in data.
			entityType: 'workspace_tool_broker',
			entityId: provisioned.toolkit.rowId,
			data: { slug, kind: body.kind, host: url.hostname },
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
							z.object({ type: z.literal('oauth') }),
						]),
						scope: z.enum(['workspace', 'personal']).optional(),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Connected, or an authorization URL to send the user to',
			content: {
				'application/json': {
					schema: z.object({
						address: z.string().optional(),
						authorizationUrl: z.string().optional(),
					}),
				},
			},
		},
		400: { description: 'This integration cannot be connected automatically' },
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

		// OAuth needs the user's browser, so this branch answers with a URL rather
		// than a finished connection. Everything after the redirect happens in the
		// callback below.
		if (body.auth.type === 'oauth') {
			const integrations = await provisioned.client.listIntegrations(
				provisioned.apiKey,
				workspaceId,
			)
			const target = integrations.find((integration) => integration.slug === slug)
			if (!target?.url) {
				return c.json(
					{ error: { message: 'This integration has no endpoint to authenticate against' } },
					400,
				)
			}

			const origin = resolvePublicOrigin(c.req.url, c.req.header())
			const redirectUri = callbackUrl(origin)

			let clientId: string
			try {
				;({ clientId } = await resolveOAuthClient(provisioned.client, provisioned.apiKey, {
					integrationSlug: slug,
					endpointUrl: target.url,
					redirectUri,
				}))
			} catch (error) {
				if (error instanceof OAuthNotSupportedError) {
					return c.json({ error: { message: error.message } }, 400)
				}
				throw error
			}

			const started = await provisioned.client.startOAuth(provisioned.apiKey, {
				client: clientId,
				integrationSlug: slug,
				redirectUri,
				scope: body.scope,
			})

			// Already holding a usable credential: nothing to authorise.
			if (started.status === 'connected') {
				await provisioned.client.admitIntegration(provisioned.apiKey, {
					toolkitId: provisioned.toolkit.toolkitId,
					integrationSlug: slug,
				})
				await refreshConnectedNames(db, provisioned, workspaceId)
				return c.json({ address: started.connection.address }, 200)
			}

			// Bind the state AS IT APPEARS IN THE AUTHORIZE URL, not the one the
			// start response returns. The backend wraps its own state into an
			// envelope before putting it in the URL — `base64({state, orgSlug})` —
			// and the provider echoes that envelope back verbatim. Binding the
			// unwrapped value compares two different strings at callback time and
			// fails every flow with invalid_state.
			const urlState = new URL(started.authorizationUrl).searchParams.get('state') ?? started.state

			bindOAuthFlow(
				c,
				{
					workspaceId,
					actorId,
					integrationSlug: slug,
					brokerState: urlState,
					completeState: started.state,
					scope: body.scope ?? 'workspace',
				},
				origin.startsWith('https://'),
			)

			return c.json({ authorizationUrl: started.authorizationUrl }, 200)
		}

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
			entityType: 'workspace_tool_broker',
			entityId: provisioned.toolkit.rowId,
			data: { slug, connected: true, scope: connection.scope },
		})

		await refreshConnectedNames(db, provisioned, workspaceId)

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
			entityType: 'workspace_tool_broker',
			entityId: provisioned.toolkit.rowId,
			data: { slug, connected: false },
		})

		await refreshConnectedNames(db, provisioned, workspaceId)

		return c.json({ success: true }, 200)
	} catch (error) {
		if (error instanceof ToolBrokerUnavailableError) {
			return c.json({ error: { message: 'Tool broker is unavailable' } }, 503)
		}
		throw error
	}
})

// ---------------------------------------------------------------------------
// OAuth callback.
//
// A top-level browser navigation from the provider, so it carries no API key —
// it is on the auth allowlist and authenticates by the encrypted binding cookie
// instead. It always redirects back to settings rather than rendering JSON: the
// user is looking at a browser tab, not calling an API.
// ---------------------------------------------------------------------------
const oauthCallbackRoute = createRoute({
	method: 'get',
	path: '/oauth/callback',
	tags: ['Tool Broker'],
	summary: 'OAuth redirect target for tool-broker integrations',
	request: {
		query: z.object({
			state: z.string().optional(),
			code: z.string().optional(),
			error: z.string().optional(),
			error_description: z.string().optional(),
		}),
	},
	responses: { 302: { description: 'Redirect back to settings' } },
})

app.openapi(oauthCallbackRoute, async (c) => {
	const { state, code, error } = c.req.valid('query')
	const origin = resolvePublicOrigin(c.req.url, c.req.header())
	const secure = origin.startsWith('https://')

	const settingsUrl = (workspaceId: string, params: Record<string, string>) => {
		const base = `${resolveWebAppBaseUrl(process.env)}/${workspaceId}/settings/integrations`
		const query = new URLSearchParams(params).toString()
		return query ? `${base}?${query}` : base
	}

	const binding = state ? readOAuthBinding(c, state) : null
	// Consume the binding whatever happens next, so one state cannot be replayed.
	clearOAuthBinding(c, secure)

	// `state` is tested alongside the binding so it narrows for completeOAuth
	// below. readOAuthBinding already refuses a mismatch; this is the type half.
	if (!state || !binding) {
		// No workspace to send them back to, so the web root is the best we can do.
		return c.redirect(`${resolveWebAppBaseUrl(process.env)}/?tool_broker_error=invalid_state`, 302)
	}

	// The user declined, or the provider refused. Their choice is not an error to
	// shout about — send them back with a quiet marker.
	if (error || !code) {
		return c.redirect(
			settingsUrl(binding.workspaceId, { tool_broker_error: error ?? 'no_code' }),
			302,
		)
	}

	try {
		const provisioned = await ensureProvisioned(c.get('db'), {
			workspaceId: binding.workspaceId,
			actorId: binding.actorId,
		})
		if (!provisioned) {
			return c.redirect(
				settingsUrl(binding.workspaceId, { tool_broker_error: 'not_configured' }),
				302,
			)
		}

		// The RAW state, not the one the provider echoed: the backend looks its
		// flow up by the unwrapped value and 404s on the envelope.
		await provisioned.client.completeOAuth(provisioned.apiKey, {
			state: binding.completeState,
			code,
		})

		// Same as every other connect: the toolkit is default-deny, so the
		// credential alone leaves the tools unreachable.
		await provisioned.client.admitIntegration(provisioned.apiKey, {
			toolkitId: provisioned.toolkit.toolkitId,
			integrationSlug: binding.integrationSlug,
		})

		await c
			.get('db')
			.insert(events)
			.values({
				workspaceId: binding.workspaceId,
				actorId: binding.actorId,
				action: 'updated',
				entityType: 'workspace_tool_broker',
				entityId: provisioned.toolkit.rowId,
				data: { slug: binding.integrationSlug, connected: true, via: 'oauth' },
			})

		await refreshConnectedNames(c.get('db'), provisioned, binding.workspaceId)

		return c.redirect(settingsUrl(binding.workspaceId, { tool_broker_connected: '1' }), 302)
	} catch (err) {
		logger.warn('Tool broker OAuth callback failed', {
			workspaceId: binding.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.redirect(
			settingsUrl(binding.workspaceId, { tool_broker_error: 'exchange_failed' }),
			302,
		)
	}
})

/**
 * Refresh the cached integration names used by the session-launch preamble.
 *
 * Best-effort by design: the cache is a prompt hint, never an authorisation
 * input, so a failure here must not fail the connect that already succeeded.
 * Worst case the preamble names one integration too many or too few until the
 * next connect refreshes it.
 */
const refreshConnectedNames = async (
	db: Database,
	provisioned: Awaited<ReturnType<typeof ensureProvisioned>>,
	workspaceId: string,
): Promise<void> => {
	if (!provisioned) return
	try {
		const [integrations, connections] = await Promise.all([
			provisioned.client.listIntegrations(provisioned.apiKey, workspaceId),
			provisioned.client.listConnections(provisioned.apiKey, workspaceId),
		])
		const connected = new Set(connections.map((connection) => connection.integrationSlug))
		const names = integrations.filter((i) => connected.has(i.slug)).map((i) => i.name)
		await db
			.update(workspaceToolBrokers)
			.set({ connectedNames: names, updatedAt: new Date() })
			.where(eq(workspaceToolBrokers.workspaceId, workspaceId))
	} catch (error) {
		logger.warn('Failed to refresh cached tool broker integration names', {
			workspaceId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export default app
