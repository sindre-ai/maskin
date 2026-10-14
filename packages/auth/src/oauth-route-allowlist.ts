/**
 * Which REST routes a mat_ (Claude connector) access token may reach.
 *
 * A mat_ token is a delegated credential handed to a third party, so it fails closed:
 * it reaches only the routes the MCP tools actually call, and every other route
 * answers 403 insufficient_scope. Entries are "METHOD /route/pattern" strings exactly
 * as Hono registers them (path parameters as :name), not raw URLs, so a trailing slash,
 * an encoded segment or a different case cannot step around the check.
 *
 * Adding a route to the app fails the route-table test in apps/dev until the route is
 * added to ONE of the two lists below. That is the point: someone has to decide.
 * Move a route from REFUSED to ALLOWED only after checking that it scopes every
 * workspace_members query to the token's pinned workspace (see oauth-pin.ts).
 *
 * Derived from the routes packages/mcp calls on localhost (packages/mcp/src/server.ts).
 */
export const OAUTH_ALLOWED_ROUTES: readonly string[] = [
	'GET /api/objects',
	'POST /api/objects',
	'GET /api/objects/search',
	'GET /api/objects/:id',
	'PATCH /api/objects/:id',
	'DELETE /api/objects/:id',
	'GET /api/objects/:id/graph',
	'GET /api/objects/:id/graph/traverse',
	'POST /api/graph',
	'GET /api/relationships',
	'POST /api/relationships',
	'DELETE /api/relationships/:id',
	'POST /api/events',
	'GET /api/events/history',
	'GET /api/files',
	'POST /api/files',
	'GET /api/files/:id',
	'PATCH /api/files/:id',
	'DELETE /api/files/:id',
	'GET /api/triggers',
	'POST /api/triggers',
	'PATCH /api/triggers/:id',
	'DELETE /api/triggers/:id',
	'GET /api/loops',
	'POST /api/installed-loops',
	'GET /api/marketplace/loops',
	'GET /api/notifications',
	'POST /api/notifications',
	'GET /api/notifications/:id',
	'PATCH /api/notifications/:id',
	'DELETE /api/notifications/:id',
	'POST /api/subscriptions/read',
	'GET /api/subscriptions/unread',
	'GET /api/sessions',
	'POST /api/sessions',
	'GET /api/sessions/:id',
	'PATCH /api/sessions/:id',
	'GET /api/sessions/:id/logs',
	'GET /api/sessions/:id/logs/deep',
	'POST /api/sessions/:id/stop',
	'POST /api/sessions/:id/pause',
	'POST /api/sessions/:id/resume',
	'GET /api/conversations/:id',
	'GET /api/conversations/:id/messages',
	'POST /api/conversations/:id/messages',
	'GET /api/actors',
	'GET /api/actors/:id',
	'PATCH /api/actors/:id',
	'DELETE /api/actors/:actorId/workspace-skills/:workspaceSkillId',
	'POST /api/actors/:actorId/workspace-skills/batch',
	'GET /api/workspaces',
	'GET /api/workspaces/:id/members',
	'GET /api/workspaces/:workspaceId/skills',
	'POST /api/workspaces/:workspaceId/skills',
	'GET /api/workspaces/:workspaceId/skills/:name',
	'PUT /api/workspaces/:workspaceId/skills/:name',
	'DELETE /api/workspaces/:workspaceId/skills/:name',
	'GET /api/integrations',
	'GET /api/integrations/providers',
	'GET /api/claude-oauth/status',
	'POST /api/telemetry/mcp',
]

/**
 * Routes a mat_ token is refused on, on purpose. The comment above each group says why.
 * Listed explicitly (rather than "everything else") so the route-table test can tell a
 * decided route from one nobody has looked at.
 */
export const OAUTH_REFUSED_ROUTES: readonly string[] = [
	// Skips authMiddleware and authenticates itself with ank_ keys only (resolveBearerCaller), so create_actor fails under a mat_ token. It returns a new actor key.
	'POST /api/actors',

	// Not called by any MCP tool, so not offered to a mat_ token in v1.
	'GET /api/actors/:actorId/skills',
	'DELETE /api/actors/:actorId/skills/:skillName',
	'GET /api/actors/:actorId/skills/:skillName',
	'PUT /api/actors/:actorId/skills/:skillName',
	'GET /api/actors/:actorId/workspace-skills',
	'POST /api/actors/:actorId/workspace-skills',
	'DELETE /api/actors/:id',
	'POST /api/actors/:id/pause',
	'POST /api/actors/:id/reset',
	'POST /api/actors/:id/run',
	'GET /api/admin/landing-funnel',
	'POST /api/admin/linkedin-unipile/refresh-identities',
	'GET /api/briefing',
	'POST /api/briefing/spoken',
	'GET /api/conversations',
	'POST /api/conversations',
	'PATCH /api/conversations/:id',
	'PATCH /api/conversations/:id/me',
	'PATCH /api/conversations/:id/messages/:messageId',
	'POST /api/conversations/:id/messages/:messageId/retry',
	'POST /api/conversations/:id/participants',
	'DELETE /api/conversations/:id/participants/:actorId',
	'GET /api/events',
	'GET /api/feature-flags',
	'GET /api/files/:id/comments',
	'POST /api/files/:id/comments',
	'PATCH /api/files/:id/comments/:cid',
	'POST /api/files/:id/comments/rounds',
	'GET /api/imports',
	'POST /api/imports',
	'GET /api/imports/:id',
	'POST /api/imports/:id/confirm',
	'PATCH /api/imports/:id/mapping',
	'GET /api/installed-loops',
	'DELETE /api/installed-loops/:id',
	'POST /api/installed-loops/:id/fork',
	'GET /api/integrations/:id/slack/conversations',
	'GET /api/integrations/:id/slack/users',
	'DELETE /api/integrations/google-meet/mcp',
	'GET /api/integrations/google-meet/mcp',
	'POST /api/integrations/google-meet/mcp',
	'POST /api/integrations/linkedin-unipile/comment-on-post',
	'GET /api/integrations/linkedin-unipile/get-post-engagement',
	'GET /api/integrations/linkedin-unipile/identities',
	'GET /api/integrations/linkedin-unipile/list-conversations',
	'DELETE /api/integrations/linkedin-unipile/mcp',
	'GET /api/integrations/linkedin-unipile/mcp',
	'POST /api/integrations/linkedin-unipile/mcp',
	'DELETE /api/integrations/linkedin-unipile/mcp/:instanceSlug',
	'GET /api/integrations/linkedin-unipile/mcp/:instanceSlug',
	'POST /api/integrations/linkedin-unipile/mcp/:instanceSlug',
	'POST /api/integrations/linkedin-unipile/publish-post',
	'GET /api/integrations/linkedin-unipile/read-post-comments',
	'POST /api/integrations/linkedin-unipile/reply',
	'POST /api/integrations/linkedin-unipile/reply-to-comment',
	'POST /api/integrations/linkedin-unipile/send-message',
	'DELETE /api/integrations/slack/mcp',
	'GET /api/integrations/slack/mcp',
	'POST /api/integrations/slack/mcp',
	'GET /api/loops/:id/activity',
	'GET /api/loops/:id/steps',
	'POST /api/marketplace/items/:id/install',
	'DELETE /api/marketplace/items/:id/uninstall',
	'GET /api/marketplace/items/installed',
	'GET /api/marketplace/loops/:id',
	'POST /api/mini-apps/regen',
	'POST /api/notifications/:id/respond',
	'GET /api/objects/:id/references',
	'DELETE /api/objects/:id/star',
	'POST /api/objects/:id/star',
	'POST /api/objects/:id/undo-write',
	'POST /api/objects/:id/verification',
	'GET /api/objects/board',
	'POST /api/objects/bulk-update',
	'POST /api/objects/migrate-type',
	'POST /api/sessions/:id/ask',
	'POST /api/sessions/:id/input',
	'GET /api/sessions/:id/logs/stream',
	'GET /api/sessions/usage',
	'DELETE /api/subscriptions',
	'POST /api/subscriptions',
	'GET /api/subscriptions/subscribers',
	'POST /api/subscriptions/unread',
	'GET /api/telemetry/mcp/summary',
	'GET /api/user-display-settings',
	'GET /api/user-display-settings/:object_type',
	'PUT /api/user-display-settings/:object_type',
	'GET /api/workspaces/:workspaceId/skills/:skillId/download',
	'GET /api/workspaces/:workspaceId/skills/:skillId/files',
	'POST /api/workspaces/:workspaceId/skills/upload',

	// Mint, return, rotate or connect credentials (API keys, Claude subscription tokens, third-party integration tokens).
	'POST /api/actors/:id/api-keys',
	'DELETE /api/claude-oauth',
	'POST /api/claude-oauth/import',
	'PATCH /api/claude-oauth/nickname',
	'POST /api/claude-oauth/promote',
	'POST /api/claude-oauth/swap',
	'DELETE /api/integrations/:id',
	'PATCH /api/integrations/:id',
	'POST /api/integrations/:id/complete',
	'GET /api/integrations/:id/github-token',
	'POST /api/integrations/:provider/connect',
	'POST /api/integrations/github/link',
	'GET /api/integrations/github/linkable',
	'GET /api/integrations/github/pending-selection/:id',
	'POST /api/integrations/github/select-installation',
	'POST /api/integrations/linkedin-unipile/connect',
	'POST /api/integrations/resend/dns-precheck',
	'POST /api/integrations/skjald/authorize',

	// The Claude connector's own consent and connections API. A connected client must not approve its own access or manage connections: only the person, with their own API key.
	'GET /api/oauth/authorize/preview',
	'POST /api/oauth/authorize/approve',
	'POST /api/oauth/authorize/deny',
	'GET /api/oauth/grants',
	'DELETE /api/oauth/grants/:id',

	// Skip authMiddleware (public, provider-signed or self-authenticating). A mat_ token never reaches the OAuth branch on these.
	'POST /api/auth/login',
	'GET /api/health',
	'GET /api/integrations/:provider/callback',
	'GET /api/integrations/linkedin-unipile/callback',
	'POST /api/integrations/linkedin-unipile/webhook',
	'POST /api/integrations/skjald/exchange',
	'POST /api/internal/agent-servers/reconcile',
	'POST /api/internal/agent-servers/sessions/:id/complete',
	'POST /api/internal/agent-servers/sessions/:id/logs',
	'POST /api/internal/agent-servers/sessions/:id/skill-staging',
	'POST /api/invites/:token/accept',
	'GET /api/invites/preview',
	'GET /api/openapi.json',
	'POST /api/public/bet-strategist/claim',
	'POST /api/public/bet-strategist/drafts',
	'POST /api/public/landing-events',
	'POST /api/webhooks/:provider',
	'POST /api/webhooks/resend/:token',
	'POST /api/webhooks/skjald/:token',
	'POST /api/webhooks/slack-actions-account-link',
	'POST /api/webhooks/slack-commands',
	'POST /api/webhooks/slack-interactive',
	'POST /api/webhooks/stripe',

	// Billing is account-level.
	'POST /api/billing/cancel',
	'POST /api/billing/checkout',
	'POST /api/billing/credits/checkout',
	'GET /api/billing/usage',

	// Create a workspace, change settings, or change who is in a workspace and with what role.
	'GET /api/invites',
	'POST /api/invites',
	'DELETE /api/invites/:id',
	'POST /api/invites/:id/resend',
	'POST /api/workspaces',
	'PATCH /api/workspaces/:id',
	'POST /api/workspaces/:id/members',
	'DELETE /api/workspaces/:id/members/:actorId',
	'PATCH /api/workspaces/:id/members/:actorId',
	'POST /api/workspaces/:id/transfer-ownership',
	'PATCH /api/workspaces/admin/:id',
]

const allowed = new Set(OAUTH_ALLOWED_ROUTES)
const refused = new Set(OAUTH_REFUSED_ROUTES)

export type OAuthRouteClass = 'allowed' | 'refused' | 'unclassified'

/** Classifies one registered route, e.g. classifyOAuthRoute('GET', '/api/objects/:id'). */
export function classifyOAuthRoute(method: string, routePattern: string): OAuthRouteClass {
	const key = `${method.toUpperCase()} ${routePattern}`
	if (allowed.has(key)) return 'allowed'
	if (refused.has(key)) return 'refused'
	return 'unclassified'
}

/**
 * Whether a request may proceed, given every non-wildcard route pattern Hono matched for
 * it. All of them must be allowed: if a request could land on an allowed route or a
 * refused one, it is refused. No matching route at all is also refused.
 */
export function isOAuthRequestAllowed(matched: ReadonlyArray<{ method: string; path: string }>) {
	const handlers = matched.filter((r) => !r.path.includes('*'))
	return (
		handlers.length > 0 && handlers.every((r) => classifyOAuthRoute(r.method, r.path) === 'allowed')
	)
}
