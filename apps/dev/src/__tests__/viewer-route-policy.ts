import type { OpenAPIHono } from '@hono/zod-openapi'
import { type Env, getOpenApiConfig } from '../app-factory'

/**
 * Viewer read-only guard: every write route is accounted for.
 *
 * A write route (POST, PUT, PATCH, DELETE) is accounted for when it is
 *   - tagged 'x-viewer-policy': 'writer' in its route config (read back from
 *     the OpenAPI document), meaning a viewer gets a 403 on it,
 *   - on OPEN_ROUTES, with the reason a viewer may reach it, or
 *   - on PENDING_ROUTES, with the group (see the write route list on the
 *     "Viewers are read-only" task) whose pull request will tag it.
 *
 * A tagged route must leave PENDING_ROUTES in the same change, so the pending
 * list only shrinks. The parent task closes when it is empty, and that pull
 * request deletes it.
 *
 * Paths are Hono paths, as in app.routes (':id', not '{id}').
 * Extension routes under /api/m are not mounted by the test app, and a route
 * not built with createRoute has no OpenAPI entry, so it can never be tagged.
 */

export const VIEWER_POLICY_KEY = 'x-viewer-policy'
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

export type OpenRoute = readonly [method: string, path: string, reason: string]
export type PendingRoute = readonly [method: string, path: string, group: string]

export const OPEN_ROUTES: OpenRoute[] = [
	// The allowlist in app-factory.ts that skips authMiddleware: no workspace caller.
	['POST', '/api/actors', 'signup bootstrap, the caller has no workspace yet'],
	['POST', '/api/auth/login', 'pre-auth credential exchange'],
	['POST', '/api/webhooks/:provider', 'provider webhook, authenticated by signature'],
	['POST', '/api/webhooks/resend/:token', 'provider webhook, authenticated by token'],
	['POST', '/api/webhooks/skjald/:token', 'provider webhook, authenticated by token'],
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
	// The Claude connector. A token a viewer approves carries the viewer role, so writes through it are refused.
	['POST', '/api/oauth/authorize/approve', 'approves a Claude connection for the caller only'],
	['POST', '/api/oauth/authorize/deny', 'declines a Claude connection for the caller only'],
	['DELETE', '/api/oauth/grants/:id', 'ends a Claude connection of the caller only'],
	['POST', '/oauth/token', 'public, the one-time code or refresh token is the credential'],
	// Group E: personal state a viewer may keep.
	['POST', '/api/notifications', 'Group E, personal state'],
	[
		'PATCH',
		'/api/notifications/:id',
		'Group E, personal state: mark read (the route also takes metadata)',
	],
	['DELETE', '/api/notifications/:id', 'Group E, personal state'],
	['POST', '/api/subscriptions', 'Group E, personal state'],
	['DELETE', '/api/subscriptions', 'Group E, personal state'],
	['POST', '/api/subscriptions/read', 'Group E, personal state'],
	['POST', '/api/subscriptions/unread', 'Group E, personal state'],
	['POST', '/api/objects/:id/star', 'Group E, personal state'],
	['DELETE', '/api/objects/:id/star', 'Group E, personal state'],
	['PUT', '/api/user-display-settings/:object_type', 'Group E, personal state'],
	['POST', '/api/briefing/spoken', 'Group E, generates a briefing and changes no workspace data'],
	['POST', '/api/telemetry/mcp', 'Group E, telemetry aggregates'],
	// The MCP endpoint: its tools call the REST API with the caller's key, so the
	// route gates above apply (the test below checks packages/mcp has no db access).
	['POST', '/mcp', 'tools reach data only through the gated REST routes'],
	['DELETE', '/mcp', 'tools reach data only through the gated REST routes'],
]

export const PENDING_ROUTES: PendingRoute[] = [
	// Group B: workspace configuration
	['PATCH', '/api/workspaces/:id', 'B'],
	['PATCH', '/api/workspaces/admin/:id', 'B'],
	['POST', '/api/workspaces/:workspaceId/skills', 'B'],
	['POST', '/api/workspaces/:workspaceId/skills/upload', 'B'],
	['PUT', '/api/workspaces/:workspaceId/skills/:name', 'B'],
	['DELETE', '/api/workspaces/:workspaceId/skills/:name', 'B'],
	['POST', '/api/triggers', 'B'],
	['PATCH', '/api/triggers/:id', 'B'],
	['DELETE', '/api/triggers/:id', 'B'],
	['POST', '/api/installed-loops', 'B'],
	['POST', '/api/installed-loops/:id/fork', 'B'],
	['DELETE', '/api/installed-loops/:id', 'B'],
	['POST', '/api/marketplace/items/:id/install', 'B'],
	['DELETE', '/api/marketplace/items/:id/uninstall', 'B'],
	['PATCH', '/api/integrations/:id', 'B'],
	['DELETE', '/api/integrations/:id', 'B'],
	['POST', '/api/integrations/:provider/connect', 'B'],
	['POST', '/api/integrations/:id/complete', 'B'],
	['POST', '/api/integrations/github/link', 'B'],
	['POST', '/api/integrations/github/select-installation', 'B'],
	['POST', '/api/integrations/resend/dns-precheck', 'B'],
	['POST', '/api/integrations/skjald/authorize', 'B'],
	['POST', '/api/integrations/google-meet/mcp', 'B'],
	['DELETE', '/api/integrations/google-meet/mcp', 'B'],
	['POST', '/api/integrations/slack/mcp', 'B'],
	['DELETE', '/api/integrations/slack/mcp', 'B'],
	['POST', '/api/integrations/linkedin-unipile/mcp', 'B'],
	['DELETE', '/api/integrations/linkedin-unipile/mcp', 'B'],
	['POST', '/api/integrations/linkedin-unipile/mcp/:instanceSlug', 'B'],
	['DELETE', '/api/integrations/linkedin-unipile/mcp/:instanceSlug', 'B'],
	['POST', '/api/integrations/linkedin-unipile/connect', 'B'],
	['POST', '/api/integrations/linkedin-unipile/publish-post', 'B'],
	['POST', '/api/integrations/linkedin-unipile/send-message', 'B'],
	['POST', '/api/integrations/linkedin-unipile/reply', 'B'],
	['POST', '/api/integrations/linkedin-unipile/comment-on-post', 'B'],
	['POST', '/api/integrations/linkedin-unipile/reply-to-comment', 'B'],
	['POST', '/api/admin/linkedin-unipile/refresh-identities', 'B'],
	['DELETE', '/api/claude-oauth', 'B'],
	['PATCH', '/api/claude-oauth/nickname', 'B'],
	['POST', '/api/claude-oauth/import', 'B'],
	['POST', '/api/claude-oauth/promote', 'B'],
	['POST', '/api/claude-oauth/swap', 'B'],
	['POST', '/api/mini-apps/regen', 'B'],
	// Group C: agents and sessions
	['PATCH', '/api/actors/:id', 'C'],
	['DELETE', '/api/actors/:id', 'C'],
	['POST', '/api/actors/:id/api-keys', 'C'],
	['POST', '/api/actors/:id/pause', 'C'],
	['POST', '/api/actors/:id/reset', 'C'],
	['POST', '/api/actors/:id/run', 'C'],
	['PUT', '/api/actors/:actorId/skills/:skillName', 'C'],
	['DELETE', '/api/actors/:actorId/skills/:skillName', 'C'],
	['POST', '/api/actors/:actorId/workspace-skills', 'C'],
	['POST', '/api/actors/:actorId/workspace-skills/batch', 'C'],
	['DELETE', '/api/actors/:actorId/workspace-skills/:workspaceSkillId', 'C'],
	['POST', '/api/sessions', 'C'],
	['PATCH', '/api/sessions/:id', 'C'],
	['POST', '/api/sessions/:id/ask', 'C'],
	['POST', '/api/sessions/:id/input', 'C'],
	['POST', '/api/sessions/:id/pause', 'C'],
	['POST', '/api/sessions/:id/resume', 'C'],
	['POST', '/api/sessions/:id/stop', 'C'],
	['POST', '/api/conversations', 'C'],
	['PATCH', '/api/conversations/:id', 'C'],
	['PATCH', '/api/conversations/:id/me', 'C'],
	['POST', '/api/conversations/:id/messages', 'C'],
	['PATCH', '/api/conversations/:id/messages/:messageId', 'C'],
	['POST', '/api/conversations/:id/messages/:messageId/retry', 'C'],
	['POST', '/api/conversations/:id/participants', 'C'],
	['DELETE', '/api/conversations/:id/participants/:actorId', 'C'],
	['POST', '/api/notifications/:id/respond', 'C'],
	// Group D: people and billing
	['POST', '/api/workspaces', 'D'],
	['POST', '/api/workspaces/:id/members', 'D'],
	['PATCH', '/api/workspaces/:id/members/:actorId', 'D'],
	['DELETE', '/api/workspaces/:id/members/:actorId', 'D'],
	['POST', '/api/workspaces/:id/transfer-ownership', 'D'],
	['POST', '/api/invites', 'D'],
	['POST', '/api/invites/:id/resend', 'D'],
	['DELETE', '/api/invites/:id', 'D'],
	['POST', '/api/billing/checkout', 'D'],
	['POST', '/api/billing/credits/checkout', 'D'],
	['POST', '/api/billing/cancel', 'D'],
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
	/** Neither tagged, nor open, nor pending. */
	unaccounted: string[]
	/** Carries an x-viewer-policy value other than 'writer'. */
	badTag: string[]
	taggedAndPending: string[]
	taggedAndOpen: string[]
	openAndPending: string[]
	/** On the open or pending list but not a route on the app. */
	staleEntries: string[]
	taggedCount: number
	openCount: number
	pendingByGroup: Record<string, number>
}

export function auditWriteRoutes(routes: WriteRoute[]): RouteAudit {
	const open = new Set(OPEN_ROUTES.map(([m, p]) => key(m, p)))
	const pending = new Set(PENDING_ROUTES.map(([m, p]) => key(m, p)))
	const group = new Map(PENDING_ROUTES.map(([m, p, g]) => [key(m, p), g]))
	const real = new Set(routes.map((r) => key(r.method, r.path)))

	const audit: RouteAudit = {
		unaccounted: [],
		badTag: [],
		taggedAndPending: [],
		taggedAndOpen: [],
		openAndPending: [],
		staleEntries: [],
		taggedCount: 0,
		openCount: 0,
		pendingByGroup: {},
	}

	for (const r of routes) {
		const k = key(r.method, r.path)
		const hasTag = r.policy !== undefined
		const tagged = r.policy === 'writer'
		if (hasTag && !tagged) audit.badTag.push(k)
		if (tagged && pending.has(k)) audit.taggedAndPending.push(k)
		if (tagged && open.has(k)) audit.taggedAndOpen.push(k)
		if (open.has(k) && pending.has(k)) audit.openAndPending.push(k)
		if (tagged) audit.taggedCount++
		else if (open.has(k)) audit.openCount++
		else if (pending.has(k)) {
			const g = group.get(k) as string
			audit.pendingByGroup[g] = (audit.pendingByGroup[g] ?? 0) + 1
		} else audit.unaccounted.push(k)
	}

	for (const k of [...open, ...pending]) if (!real.has(k)) audit.staleEntries.push(k)
	return audit
}
