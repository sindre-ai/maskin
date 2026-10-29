import type { OpenAPIHono } from '@hono/zod-openapi'
import { type Env, getOpenApiConfig } from '../app-factory'

/**
 * Viewer read-only guard: every write route is accounted for.
 *
 * A write route (POST, PUT, PATCH, DELETE) is accounted for when it is
 *   - tagged 'x-viewer-policy': 'writer' in its route config (read back from
 *     the OpenAPI document), meaning a viewer gets a 403 on it,
 *   - on HAND_GATED_ROUTES: gated in the handler but not built with createRoute,
 *     so it has no OpenAPI entry to tag (the viewer 403 test proves the gate), or
 *   - on OPEN_ROUTES, with the reason a viewer may reach it.
 *
 * Paths are Hono paths, as in app.routes (':id', not '{id}').
 * Extension routes under /api/m are not mounted by the test app, and a route
 * not built with createRoute has no OpenAPI entry, so it can never be tagged.
 * Those go on HAND_GATED_ROUTES instead, and need a case in the viewer 403 test.
 */

export const VIEWER_POLICY_KEY = 'x-viewer-policy'
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

export type OpenRoute = readonly [method: string, path: string, reason: string]

export const OPEN_ROUTES: OpenRoute[] = [
	// The allowlist in app-factory.ts that skips authMiddleware: no workspace caller.
	[
		'POST',
		'/api/actors',
		'human signup stays open, the caller has no workspace yet; the agent branch is gated in the handler (a viewer naming a workspace gets 403)',
	],
	['POST', '/api/auth/login', 'pre-auth credential exchange'],
	[
		'POST',
		'/api/voice-sessions/:id/hangup',
		'ends the caller’s own call; a member demoted to viewer mid-call must still be able to hang up, or the call keeps running and billing',
	],
	['POST', '/api/webhooks/:provider', 'provider webhook, authenticated by signature'],
	['POST', '/api/webhooks/google-drive', 'provider webhook, authenticated by channel token'],
	['POST', '/api/webhooks/resend/:token', 'provider webhook, authenticated by token'],
	['POST', '/api/webhooks/skjald/:token', 'provider webhook, authenticated by token'],
	['POST', '/api/webhooks/x/:token', 'custom extension webhook, signed with the extension secret'],
	[
		'POST',
		'/api/internal/mcp-guard/report',
		'guard wrapper in an agent container, authenticated by session key',
	],
	['POST', '/api/webhooks/slack-actions-account-link', 'provider webhook, signed by Slack'],
	['POST', '/api/webhooks/slack-commands', 'provider webhook, signed by Slack'],
	['POST', '/api/webhooks/slack-interactive', 'provider webhook, signed by Slack'],
	['POST', '/api/webhooks/stripe', 'provider webhook, signed by Stripe'],
	['POST', '/api/internal/agent-servers/reconcile', 'shared bearer secret, no workspace caller'],
	[
		'POST',
		'/api/internal/agent-servers/sessions/:id/complete',
		'shared bearer secret, no workspace caller',
	],
	[
		'POST',
		'/api/internal/agent-servers/sessions/:id/logs',
		'shared bearer secret, no workspace caller',
	],
	[
		'POST',
		'/api/internal/agent-servers/sessions/:id/skill-staging',
		'shared bearer secret, no workspace caller',
	],
	['POST', '/api/public/landing-events', 'public funnel ingest, rate-limited in the handler'],
	['POST', '/api/public/bet-strategist/drafts', 'public, no workspace involved'],
	['POST', '/api/public/bet-strategist/claim', 'public, no workspace involved'],
	['POST', '/api/invites/:token/accept', 'the invitee is not a member of any workspace yet'],
	[
		'POST',
		'/api/integrations/skjald/exchange',
		'the one-time code and its PKCE verifier are the credential',
	],
	['POST', '/api/integrations/linkedin-unipile/webhook', 'provider webhook, authenticated by HMAC'],
	[
		'POST',
		'/api/integrations/telnyx/webhook',
		'provider webhook, authenticated by Ed25519 signature',
	],
	[
		'POST',
		'/api/integrations/telnyx/tools/:toolName',
		'called by the Telnyx assistant, authenticated by a shared bearer secret',
	],
	// Group B leftovers: no handler logic or no workspace data.
	['DELETE', '/api/integrations/google-drive/mcp', 'always answers 405, no handler'],
	['DELETE', '/api/integrations/google-meet/mcp', 'always answers 405, no handler'],
	['DELETE', '/api/integrations/google-search-console/mcp', 'always answers 405, no handler'],
	['DELETE', '/api/integrations/slack/mcp', 'always answers 405, no handler'],
	// Per-actor push registration: it writes the caller's own device row and touches no
	// workspace data, and a read-only viewer still wants their own notifications.
	['POST', '/api/devices', 'registers the caller\u2019s own device, no workspace data'],
	['DELETE', '/api/devices/:id_or_token', 'removes only the caller\u2019s own device'],
	[
		'POST',
		'/api/devices/unregister',
		'public, removes only the device that proves it holds its own secret, no workspace data',
	],
	['PUT', '/api/notification-preferences', 'saves only the caller\u2019s own push preferences'],
	[
		'POST',
		'/api/live-activities/tokens',
		'registers a Live Activity token for the caller\u2019s own device',
	],
	['DELETE', '/api/live-activities/tokens/:id', 'removes only the caller\u2019s own token'],
	// Device sign-in (Apple TV): start/token are public and write only the device's own code row;
	// approve/deny act on a code, not on workspace data, so a read-only viewer can still sign in a TV.
	['POST', '/api/device-auth/start', 'public, creates only the device\u2019s own sign-in code'],
	['POST', '/api/device-auth/token', 'public, polls the device\u2019s own sign-in code'],
	['POST', '/api/device-auth/approve', 'approves a sign-in code for the caller\u2019s own account'],
	['POST', '/api/device-auth/deny', 'refuses a sign-in code, no workspace data'],
	[
		'POST',
		'/api/web-push/subscriptions',
		'registers the caller\u2019s own browser, no workspace data',
	],
	['DELETE', '/api/web-push/subscriptions/:id', 'removes only the caller\u2019s own subscription'],
	['DELETE', '/api/integrations/linkedin-unipile/mcp', 'always answers 405, no handler'],
	[
		'DELETE',
		'/api/integrations/linkedin-unipile/mcp/:instanceSlug',
		'always answers 405, no handler',
	],
	[
		'POST',
		'/api/integrations/resend/dns-precheck',
		'looks up public DNS records for a typed domain, touches no workspace data',
	],
	// Group E: personal state a viewer may keep.
	[
		'PATCH',
		'/api/notifications/:id',
		'Group E, personal state: a viewer may change only a notification addressed to them (mark read); changing anyone else’s needs the writer check in the handler',
	],
	[
		'DELETE',
		'/api/notifications/:id',
		'Group E, personal state: a viewer may delete only a notification addressed to them; deleting anyone else’s needs the writer check in the handler',
	],
	[
		'PATCH',
		'/api/conversations/:id/me',
		"Group E, personal state: the caller's own pin, archive and read marker",
	],
	[
		'PUT',
		'/api/conversations/:id/messages/:messageId/thread/read',
		"Group E, personal state: the caller's own thread read marker",
	],
	['POST', '/api/subscriptions', 'Group E, personal state'],
	['DELETE', '/api/subscriptions', 'Group E, personal state'],
	['POST', '/api/subscriptions/read', 'Group E, personal state'],
	['POST', '/api/subscriptions/unread', 'Group E, personal state'],
	['POST', '/api/objects/:id/star', 'Group E, personal state'],
	['DELETE', '/api/objects/:id/star', 'Group E, personal state'],
	['PUT', '/api/user-display-settings/:object_type', 'Group E, personal state'],
	['POST', '/api/briefing/spoken', 'Group E, generates a briefing and changes no workspace data'],
	['POST', '/api/telemetry/mcp', 'Group E, telemetry aggregates'],
	[
		'POST',
		'/api/account/delete',
		'deleting your own account (App Store 5.1.1(v)) must work for every role, viewers included; it acts only on the caller, behind a password re-entry',
	],
	// Group D leftovers: the two routes that are not gated on a human admin or owner.
	[
		'POST',
		'/api/workspaces',
		'Group D, creates a new workspace the caller owns and touches no existing workspace',
	],
	[
		'DELETE',
		'/api/workspaces/:id/members/:actorId',
		'Group D, a member may remove themselves (leave); removing anyone else needs a human admin or owner',
	],
	// The MCP endpoint: its tools call the REST API with the caller's key, so the
	// route gates above apply (the test below checks packages/mcp has no db access).
	['POST', '/mcp', 'tools reach data only through the gated REST routes'],
	['DELETE', '/mcp', 'tools reach data only through the gated REST routes'],
]

/**
 * Gated in the handler (assertWorkspaceWriterRole or isWorkspaceWriter) but not
 * built with createRoute, so the OpenAPI document cannot carry the tag. Each
 * entry needs a viewer 403 case in integration/viewer-read-only.test.ts.
 */
export const HAND_GATED_ROUTES: OpenRoute[] = [
	['POST', '/api/integrations/google-drive/mcp', 'MCP endpoint, tools act as the workspace'],
	['POST', '/api/integrations/google-meet/mcp', 'MCP endpoint, tools act as the workspace'],
	[
		'POST',
		'/api/integrations/google-search-console/mcp',
		'MCP endpoint, tools read as the workspace',
	],
	['POST', '/api/integrations/slack/mcp', 'MCP endpoint, tools post as the workspace bot'],
	[
		'POST',
		'/api/integrations/:provider/gateway',
		'MCP gateway, forwards tool calls with the provider token',
	],
	['DELETE', '/api/integrations/:provider/gateway', 'MCP gateway, ends the provider MCP session'],
	[
		'POST',
		'/api/custom-mcp-servers/:id/gateway',
		'MCP gateway, forwards tool calls to a custom server with its stored headers',
	],
	[
		'DELETE',
		'/api/custom-mcp-servers/:id/gateway',
		'MCP gateway, ends the custom server MCP session',
	],
	['POST', '/api/integrations/linkedin-unipile/mcp', 'MCP endpoint, tools act as the identity'],
	[
		'POST',
		'/api/integrations/linkedin-unipile/mcp/:instanceSlug',
		'MCP endpoint, tools act as the identity',
	],
	['POST', '/api/integrations/linkedin-unipile/send-message', 'sends a LinkedIn message'],
	['POST', '/api/integrations/linkedin-unipile/reply', 'sends a LinkedIn reply'],
	['POST', '/api/integrations/linkedin-unipile/publish-post', 'publishes a LinkedIn post'],
	['POST', '/api/integrations/linkedin-unipile/comment-on-post', 'posts a LinkedIn comment'],
	['POST', '/api/integrations/linkedin-unipile/reply-to-comment', 'posts a LinkedIn reply'],
	['POST', '/api/admin/linkedin-unipile/refresh-identities', 'refreshes stored credentials'],
]

export interface WriteRoute {
	method: string
	path: string
	/** The x-viewer-policy value in the OpenAPI document, or undefined when untagged or not documented. */
	policy: unknown
}

const key = (method: string, path: string) => `${method} ${path}`

/** Every distinct write route on the app, with its tag read from the OpenAPI document. */
export function listWriteRoutes(app: OpenAPIHono<Env>): WriteRoute[] {
	const doc = app.getOpenAPI31Document(getOpenApiConfig())
	const paths = (doc.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>
	const seen = new Set<string>()
	const routes: WriteRoute[] = []
	for (const { method, path } of app.routes) {
		if (!WRITE_METHODS.includes(method) || seen.has(key(method, path))) continue
		seen.add(key(method, path))
		const openApiPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
		const operation = paths[openApiPath]?.[method.toLowerCase()]
		routes.push({ method, path, policy: operation?.[VIEWER_POLICY_KEY] })
	}
	return routes
}

export interface RouteAudit {
	/** Neither tagged, nor open, nor hand-gated. */
	unaccounted: string[]
	/** Carries an x-viewer-policy value other than 'writer'. */
	badTag: string[]
	taggedAndOpen: string[]
	taggedAndHandGated: string[]
	handGatedAndOpen: string[]
	/** On the open or hand-gated list but not a route on the app. */
	staleEntries: string[]
	taggedCount: number
	handGatedCount: number
	openCount: number
}

export function auditWriteRoutes(routes: WriteRoute[]): RouteAudit {
	const open = new Set(OPEN_ROUTES.map(([m, p]) => key(m, p)))
	const handGated = new Set(HAND_GATED_ROUTES.map(([m, p]) => key(m, p)))
	const real = new Set(routes.map((r) => key(r.method, r.path)))

	const audit: RouteAudit = {
		unaccounted: [],
		badTag: [],
		taggedAndOpen: [],
		taggedAndHandGated: [],
		handGatedAndOpen: [],
		staleEntries: [],
		taggedCount: 0,
		handGatedCount: 0,
		openCount: 0,
	}

	for (const r of routes) {
		const k = key(r.method, r.path)
		const hasTag = r.policy !== undefined
		const tagged = r.policy === 'writer'
		if (hasTag && !tagged) audit.badTag.push(k)
		if (tagged && open.has(k)) audit.taggedAndOpen.push(k)
		if (tagged && handGated.has(k)) audit.taggedAndHandGated.push(k)
		if (handGated.has(k) && open.has(k)) audit.handGatedAndOpen.push(k)
		if (tagged) audit.taggedCount++
		else if (handGated.has(k)) audit.handGatedCount++
		else if (open.has(k)) audit.openCount++
		else audit.unaccounted.push(k)
	}

	for (const k of [...open, ...handGated]) if (!real.has(k)) audit.staleEntries.push(k)
	return audit
}
