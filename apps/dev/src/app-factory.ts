import fs from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { type NodeWebSocket, createNodeWebSocket } from '@hono/node-ws'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { getAllModules } from '@maskin/module-sdk'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { CLIENT_SOURCE_HEADER } from './lib/analytics/knowledge-events'
import { buildAppleAppSiteAssociation } from './lib/apple-app-site-association'
import { ApiErrorCode, createApiError, mapStatusToCode, validationFailureHook } from './lib/errors'
import { registerTelnyxToolRouter } from './lib/integrations/providers/telnyx/tools'
import { PlanCapExceededError } from './lib/llm-routing'
import { logger } from './lib/logger'
import { registerVoiceCallHooks } from './lib/outreach/voice/call-hooks'
import { redactLogLine } from './lib/redact-path'
import { Sentry, resolveClientSourceTag } from './lib/sentry'
import {
	OwnershipCapExceededError,
	SeatCapExceededError,
	ownershipCapErrorBody,
	seatCapErrorBody,
} from './lib/workspace-capacity'
import { createIdempotencyMiddleware } from './middleware/idempotency'
import accountRoutes from './routes/account'
import actorAvatarRoutes from './routes/actor-avatar'
import actorsRoutes from './routes/actors'
import adminLandingFunnelRoutes from './routes/admin-landing-funnel'
import adminLinkedinUnipileRoutes from './routes/admin-linkedin-unipile'
import agentServerReconcileRoutes from './routes/agent-server-reconcile'
import agentSkillAttachmentsRoutes from './routes/agent-skill-attachments'
import agentSkillsRoutes from './routes/agent-skills'
import authRoutes from './routes/auth'
import billingRoutes from './routes/billing'
import briefingRoutes from './routes/briefing'
import claudeOauthRoutes from './routes/claude-oauth'
import conversationsRoutes from './routes/conversations'
// import desktopTeachRoutes from './routes/desktop-teach'
import customMcpServersRoutes from './routes/custom-mcp-servers'
import desktopRoutes from './routes/desktop'
import deviceAuthRoutes from './routes/device-auth'
import devicesRoutes from './routes/devices'
import eventsRoutes from './routes/events'
import extensionsRoutes from './routes/extensions'
import featureFlagsRoutes from './routes/feature-flags'
import fileCommentsRoutes from './routes/file-comments'
import filesRoutes from './routes/files'
import forYouRoutes from './routes/for-you'
import graphRoutes from './routes/graph'
import importsRoutes from './routes/imports'
import installedLoopsRoutes from './routes/installed-loops'
import integrationsRoutes, { webhookApp } from './routes/integrations'
import integrationsGatewayRoutes from './routes/integrations-gateway'
import integrationsGmailRoutes from './routes/integrations-gmail'
import integrationsGoogleDisconnectRoutes from './routes/integrations-google-disconnect'
import integrationsGoogleDriveRoutes from './routes/integrations-google-drive'
import integrationsGoogleDriveMcpRoutes from './routes/integrations-google-drive-mcp'
import integrationsGoogleMeetMcpRoutes from './routes/integrations-google-meet-mcp'
import integrationsGoogleSearchConsoleMcpRoutes from './routes/integrations-google-search-console-mcp'
import integrationsGrantsRoutes from './routes/integrations-grants'
import integrationsKeychainRoutes from './routes/integrations-keychain'
import integrationsLinkedinRoutes from './routes/integrations-linkedin-unipile'
import integrationsLinkedinMcpRoutes from './routes/integrations-linkedin-unipile-mcp'
import integrationsSkjaldConnectRoutes from './routes/integrations-skjald-connect'
import integrationsSlackMcpRoutes from './routes/integrations-slack-mcp'
import integrationsTelnyxToolsRoutes from './routes/integrations-telnyx-tools'
import integrationsTelnyxWebhookRoutes from './routes/integrations-telnyx-webhook'
import keychainAdminRoutes from './routes/keychain-admin'
import liveActivitiesRoutes from './routes/live-activities'
import loopsRoutes from './routes/loops'
import marketplaceLoopsRoutes from './routes/marketplace-loops'
import mcpRoutes from './routes/mcp'
import mcpGuardRoutes from './routes/mcp-guard'
import methodRoutes from './routes/method'
import miniAppRegenRoutes from './routes/mini-app-regen'
import notificationPreferencesRoutes from './routes/notification-preferences'
import notificationsRoutes from './routes/notifications'
import objectApprovalsRoutes from './routes/object-approvals'
import objectsRoutes from './routes/objects'
import publicBetStrategistRoutes from './routes/public-bet-strategist'
import publicLandingEventsRoutes from './routes/public-landing-events'
import relationshipsRoutes from './routes/relationships'
import searchRoutes from './routes/search'
import sessionsRoutes from './routes/sessions'
import stripeWebhookRoutes from './routes/stripe-webhook'
import subscriptionsRoutes from './routes/subscriptions'
import telemetryRoutes from './routes/telemetry'
import testGrantsRoutes, { isTestGrantEnabled } from './routes/test-grants'
import transcriptionsRoutes from './routes/transcriptions'
import triggersRoutes from './routes/triggers'
import userDisplaySettingsRoutes from './routes/user-display-settings'
import voiceSessionsRoutes from './routes/voice-sessions'
import webPushRoutes from './routes/web-push'
import workspaceInvitationsRoutes from './routes/workspace-invitations'
import workspaceSkillsRoutes from './routes/workspace-skills'
import workspacesRoutes from './routes/workspaces'
import type { AgentStorageManager } from './services/agent-storage'
import type { SessionManager } from './services/session-manager'

export type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
		agentStorage: AgentStorageManager
		storageProvider: StorageProvider
		/**
		 * The originating session's id, when the request carried a well-formed
		 * `X-Maskin-Session-Id` header (S2 writer hook). Undefined for human
		 * writes direct from the UI and for any request whose header was
		 * missing / not a uuid. Route handlers pass this to `recordEvent` via
		 * `provenance: { sessionId, entityKind }` on object/file mutations to
		 * trigger the `produced_by` edge write.
		 */
		maskinSessionId?: string
	}
}

export interface AppDeps {
	db: Database
	notifyBridge: PgNotifyBridge
	sessionManager: SessionManager
	agentStorage: AgentStorageManager
	storageProvider: StorageProvider
}

export interface CreateAppOptions {
	/** Port advertised in the OpenAPI `servers` URL. Defaults to PORT env or 3000. */
	port?: number
	/** Comma-separated CORS origins. Defaults to CORS_ORIGIN env or ['http://localhost:5173']. */
	corsOrigins?: string[]
	/** Directory to serve as static files (SPA). Defaults to STATIC_DIR env or ../../web/dist. */
	staticDir?: string
	/**
	 * Mount routes from `@maskin/module-sdk` registered modules. Defaults to true.
	 * Set to false for spec-export paths — third-party extension routes aren't
	 * part of the core OpenAPI contract, and booting them costs time and risks
	 * side effects for no benefit when we just want the spec.
	 */
	includeExtensions?: boolean
	/**
	 * Receives the Node WebSocket handle created for this app. The server boot
	 * (index.ts) calls `injectWebSocket(server)` on it once `serve()` returns —
	 * upgrade requests are only routed to the app after that. Optional so tests
	 * and spec-export paths, which never open a socket, can ignore it.
	 */
	onNodeWebSocket?: (nodeWebSocket: NodeWebSocket) => void
}

const STATIC_FILE_PATH_RE =
	/^\/(assets|fonts)\/|\.(js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|txt|xml|webmanifest)$/i

const OPENAPI_INFO = {
	title: 'Maskin Dev Workspace API',
	version: '0.1.0',
	description: 'Unified API for insights, bets, tasks, actors, and automation',
}

export function getOpenApiConfig(port = 3000) {
	return {
		openapi: '3.1.0' as const,
		info: OPENAPI_INFO,
		servers: [{ url: `http://localhost:${port}` }],
	}
}

export function createApp(deps: AppDeps, options: CreateAppOptions = {}): OpenAPIHono<Env> {
	const { db, notifyBridge, sessionManager, agentStorage, storageProvider } = deps
	const port = options.port ?? (Number(process.env.PORT) || 3000)
	const allowedOrigins =
		options.corsOrigins ??
		(process.env.CORS_ORIGIN
			? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
			: ['http://localhost:5173'])

	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	const nodeWebSocket = createNodeWebSocket({ app })
	options.onNodeWebSocket?.(nodeWebSocket)

	app.onError((err, c) => {
		if (err instanceof PlanCapExceededError) {
			logger.warn('Plan cap exceeded', {
				plan: err.plan,
				used: err.used,
				cap: err.cap,
				periodEnd: err.periodEnd,
			})
			return c.json(
				{
					error: {
						code: ApiErrorCode.PLAN_CAP_EXCEEDED,
						message: err.message,
						plan: err.plan,
						used: err.used,
						cap: err.cap,
						period_end: err.periodEnd,
					},
				},
				402,
			)
		}
		if (err instanceof SeatCapExceededError) {
			logger.warn('Workspace seat cap exceeded', {
				workspaceId: err.workspaceId,
				plan: err.plan,
				used: err.used,
				cap: err.cap,
			})
			return c.json(seatCapErrorBody(err), 403)
		}
		if (err instanceof OwnershipCapExceededError) {
			logger.warn('Workspace ownership cap exceeded', {
				actorId: err.actorId,
				effectiveTier: err.effectiveTier,
				used: err.used,
				cap: err.cap,
			})
			return c.json(ownershipCapErrorBody(err), 403)
		}
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		const cause = (err as { cause?: unknown }).cause as
			| {
					message?: string
					code?: string
					detail?: string
					hint?: string
					position?: string
					where?: string
					schema_name?: string
					table_name?: string
					column_name?: string
			  }
			| undefined
		// Non-Postgres errors (S3 ECONNREFUSED, fetch failures, AggregateError,
		// etc.) don't populate the pg* fields on `cause`, so a raw `Unhandled
		// error` line with only pgCode=undefined tells the on-call nothing. Pull
		// the error's own name + optional `code` off the top-level err so
		// e.g. an S3 ECONNREFUSED shows up as `errName: AggregateError,
		// errCode: ECONNREFUSED` in the webServer stdout Playwright captures.
		const errName = (err as { name?: string }).name
		const errCode = (err as { code?: string }).code
		// Guarded — this is the last line of defense before a response goes out.
		// A throwing Sentry call must never suppress the actual error response
		// or the diagnostic log line below.
		try {
			Sentry.captureException(err, {
				tags: { path: c.req.path, method: c.req.method },
				extra: { pgCode: cause?.code, pgTable: cause?.table_name, errCode, errName },
			})
		} catch (sentryErr) {
			console.error('[sentry] captureException failed', sentryErr)
		}
		logger.error(
			'Unhandled error',
			{
				error: String(err),
				errName,
				errCode,
				cause: cause?.message ?? (cause ? String(cause) : undefined),
				pgCode: cause?.code,
				pgDetail: cause?.detail,
				pgHint: cause?.hint,
				pgPosition: cause?.position,
				pgWhere: cause?.where,
				pgSchema: cause?.schema_name,
				pgTable: cause?.table_name,
				pgColumn: cause?.column_name,
				stack: err.stack,
			},
			{ skipSentry: true },
		)
		return c.json(createApiError(ApiErrorCode.INTERNAL_ERROR, 'An unexpected error occurred'), 500)
	})

	// /mcp uses a wildcard origin without credentials because chat-client
	// webviews vary by origin. Do NOT add `credentials: true` to the /mcp
	// policy — browsers reject wildcard + credentials together. /api/* uses
	// the configured-origin policy with credentials for the web app.
	app.use('/mcp', cors())
	app.use('/api/*', cors({ origin: allowedOrigins, credentials: true }))
	app.use(
		'*',
		honoLogger((line, ...rest) => console.log(redactLogLine(line.replace(/\?\S*/, '')), ...rest)),
	)

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('notifyBridge', notifyBridge)
		c.set('sessionManager', sessionManager)
		c.set('agentStorage', agentStorage)
		c.set('storageProvider', storageProvider)
		await next()
	})

	app.get('/api/health', (c) => {
		return c.json({ status: 'ok', timestamp: new Date().toISOString() })
	})

	// Auth allowlist — each exemption has a distinct reason; do not tighten
	// without checking the corresponding flow:
	//   - /api/health, /api/openapi.json: public discovery endpoints
	//   - POST /api/actors: signup bootstrap, mints the first API key
	//   - POST /api/auth/login: pre-auth credential exchange
	//   - POST /api/device-auth/start and /token: a keyboard-less device (Apple TV) asking to be
	//     signed in. Both are rate limited per IP inside the handler; the sign-in itself only
	//     completes after a signed-in person approves the code (/preview, /approve, /deny, which
	//     DO go through auth).
	//   - POST /api/devices/unregister: a signed-out phone dropping its own push registration. It has
	//     no API key after sign-out, so the device secret it registered with is the credential
	//     (checked and rate limited per IP inside the handler; routes/devices.ts).
	//   - /api/webhooks/*: authenticated via provider HMAC, not our API key
	//   - /api/integrations/{provider}/callback: OAuth redirect can't carry our header
	//   - GET /api/integrations/{provider}/native-launch: same, for native connect
	//   - POST /api/public/landing-events: landing-page funnel event ingest
	//     (per-IP rate-limited inside the handler).
	//   - /api/internal/agent-servers/*: authenticated via the shared bearer
	//     secret enforced inside the handler, not our API key.
	//   - POST /api/internal/mcp-guard/report: the guard wrapper in an agent container
	//     reports a refused tool call with a per-session key checked in the handler.
	//   - POST /api/invites/:token/accept and GET /api/invites/preview: the
	//     invitee is not yet a member of any workspace, so the standard
	//     Bearer + X-Workspace-Id middleware cannot admit them. The accept
	//     handler reads Authorization itself for the authenticated branch;
	//     preview is IP-rate-limited inside the handler. Frontends MUST NOT
	//     send X-Workspace-Id on these calls.
	const auth = authMiddleware(db)
	app.use('/api/*', async (c, next) => {
		const path = c.req.path
		const method = c.req.method
		if (path === '/api/health' || path === '/api/openapi.json') return next()
		if (path === '/api/actors' && method === 'POST') return next()
		// Profile pictures load through <img>, which cannot send an API key. Image bytes only, and only with the current ?v= (routes/actor-avatar.ts).
		if (method === 'GET' && /^\/api\/actors\/[0-9a-f-]{36}\/avatar$/i.test(path)) return next()
		if (path === '/api/auth/login' && method === 'POST') return next()
		if (
			method === 'POST' &&
			(path === '/api/device-auth/start' || path === '/api/device-auth/token')
		) {
			return next()
		}
		if (path === '/api/devices/unregister' && method === 'POST') return next()
		if (path.startsWith('/api/webhooks/')) return next()
		if (path.startsWith('/api/internal/agent-servers/')) return next()
		if (path === '/api/internal/mcp-guard/report' && method === 'POST') return next()
		if (path === '/api/public/landing-events' && method === 'POST') return next()
		if (path === '/api/public/bet-strategist/drafts' && method === 'POST') return next()
		if (path === '/api/public/bet-strategist/claim' && method === 'POST') return next()
		if (path === '/api/invites/preview' && method === 'GET') return next()
		if (method === 'POST' && /^\/api\/invites\/[^/]+\/accept$/.test(path)) return next()
		if (/^\/api\/integrations\/[^/]+\/callback$/.test(path)) return next()
		// Native connect: the web-auth browser has no API key either. The sealed, 2-minute
		// ticket is the credential; it sets the state-binding cookie then 302s to the provider.
		if (method === 'GET' && /^\/api\/integrations\/[^/]+\/native-launch$/.test(path)) return next()
		// The Skjald app trades its one-time connect code here. It has no API key, so the code and its PKCE
		// verifier are the credential (routes/integrations-skjald-connect.ts).
		if (path === '/api/integrations/skjald/exchange' && method === 'POST') return next()
		// R11-C · linkedin-unipile fan-out webhook. Unipile POSTs the
		// `account.reconnect` event from outside our network, so it cannot
		// carry a Maskin API key — authenticated by Unipile v2's per-endpoint
		// `unipile-signature` HMAC header, verified inside the handler
		// against `UNIPILE_WEBHOOK_SECRET`.
		if (path === '/api/integrations/linkedin-unipile/webhook' && method === 'POST') return next()
		// Telnyx call-event webhook: posted from outside our network, so it cannot carry a
		// Maskin API key. Authenticated by the Ed25519 signature check inside the handler.
		if (path === '/api/integrations/telnyx/webhook' && method === 'POST') return next()
		// Telnyx assistant tool calls: plain JSON POSTs from outside our network, authenticated by the
		// shared Bearer secret (TELNYX_TOOL_WEBHOOK_SECRET) checked inside the handler.
		if (method === 'POST' && /^\/api\/integrations\/telnyx\/tools\/[^/]+$/.test(path)) return next()
		// The linkedin-unipile MCP endpoints are POST-only and answer every GET with
		// a bare 405 (routes/integrations-linkedin-unipile-mcp.ts). MCP clients
		// probe them with GET to open a server-to-client stream and retry, ~250k
		// times a week, and each one paid two auth round trips to be told no.
		// Same response, answered before auth.
		if (method === 'GET' && /^\/api\/integrations\/linkedin-unipile\/mcp(\/[^/]+)?$/.test(path)) {
			return c.text('Method Not Allowed', 405)
		}

		return auth(c, next)
	})

	// Tag Sentry events with who hit them — actor/workspace UUIDs only, no
	// email or IP (see Sentry's `userInfo` data-collection option, which we
	// deliberately don't enable). Runs after `auth` so actorId is set when
	// present; unauthenticated routes just skip tagging.
	// Guarded like every other Sentry call in this file — this runs on every
	// request, not just the error path, so a throwing Sentry call here must
	// never block the request from reaching its route handler.
	app.use('/api/*', async (c, next) => {
		try {
			const actorId = c.get('actorId')
			if (actorId) Sentry.setUser({ id: actorId })
			const workspaceId = c.req.header('X-Workspace-Id')
			if (workspaceId) Sentry.setTag('workspaceId', workspaceId)
			// Which of our own clients made the call (ui / mcp / agent / …), so an
			// error can be traced to a caller without touching the user-agent —
			// that string carries browser + OS versions and is a fingerprinting
			// vector, whereas this is a closed set of our own component names.
			// Clamped to the allowlist because the header is caller-supplied free
			// text: an unrecognised value must not become an unbounded tag.
			Sentry.setTag('clientSource', resolveClientSourceTag(c.req.header(CLIENT_SOURCE_HEADER)))
			// 'human' | 'agent' — a coarse, non-identifying split that separates
			// autonomous-agent traffic from human traffic when triaging.
			const actorType = c.get('actorType')
			if (actorType) Sentry.setTag('actorType', actorType)
		} catch (sentryErr) {
			console.error('[sentry] setUser/setTag failed', sentryErr)
		}
		await next()
	})

	// S2 writer-hook · attribute a mutation to its originating session by
	// reading the `X-Maskin-Session-Id` header once at the boundary and
	// stashing it on the context. Any route that then calls `recordEvent`
	// with `provenance: { sessionId: c.get('maskinSessionId'), entityKind }`
	// gets a `session → object|file` `produced_by` edge for free. Non-mutating
	// requests are unaffected; requests without the header — human writes
	// direct from the UI — leave the context value undefined and no edge
	// lands, exactly the intended contract.
	app.use('/api/*', async (c, next) => {
		const raw = c.req.header('X-Maskin-Session-Id')?.trim()
		if (raw && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
			c.set('maskinSessionId', raw)
		}
		await next()
	})

	app.use('/api/*', createIdempotencyMiddleware(db))

	app.route('/api/objects', objectApprovalsRoutes)
	app.route('/api/objects', objectsRoutes)
	app.route('/api/briefing', briefingRoutes)
	app.route('/api/public/landing-events', publicLandingEventsRoutes)
	app.route('/api/public/bet-strategist', publicBetStrategistRoutes)
	app.route('/api/admin/landing-funnel', adminLandingFunnelRoutes)
	// R11-A · workspace-scoped admin re-run of linkedin identity enumeration.
	// Not surfaced as an MCP tool per spec §10 R11 item 3 — humans/ops only.
	app.route('/api/admin/linkedin-unipile', adminLinkedinUnipileRoutes)
	app.route('/api/actors', actorsRoutes)
	app.route('/api/auth', authRoutes)
	app.route('/api/device-auth', deviceAuthRoutes)
	app.route('/api/account', accountRoutes)
	app.route('/api/actors', actorAvatarRoutes)
	app.route('/api/actors', agentSkillsRoutes)
	app.route('/api/actors', agentSkillAttachmentsRoutes)
	app.route('/api/workspaces', workspacesRoutes)
	app.route('/api/workspaces', workspaceSkillsRoutes)
	app.route('/api/invites', workspaceInvitationsRoutes)
	app.route('/api/relationships', relationshipsRoutes)
	app.route('/api/triggers', triggersRoutes)
	app.route('/api/loops', loopsRoutes)
	// linkedin-unipile connect + callback use LinkedIn's Hosted Auth Wizard, NOT
	// OAuth2 — so this dedicated route file handles /connect + /callback for
	// that provider directly. Mounted BEFORE the generic /api/integrations so
	// the more-specific prefix wins Hono's trie; without this, the generic
	// /{provider}/connect handler would try to build an OAuth2 authorization
	// URL for linkedin-unipile and fail.
	// The /mcp subtree is registered BEFORE the provider's own routes so the
	// more specific prefix wins the trie — same ordering as Slack's below.
	// Skjald's one-click connect has its own two routes under /skjald; mounted before the generic catch-all.
	app.route('/api/integrations/skjald', integrationsSkjaldConnectRoutes)
	app.route('/api/integrations/linkedin-unipile/mcp', integrationsLinkedinMcpRoutes)
	app.route('/api/integrations/linkedin-unipile', integrationsLinkedinRoutes)
	// google-meet MCP surface — same trie-ordering constraint as linkedin's:
	// mount the /mcp subtree BEFORE the generic /api/integrations catch-all.
	app.route('/api/integrations/google-meet/mcp', integrationsGoogleMeetMcpRoutes)
	registerTelnyxToolRouter()
	registerVoiceCallHooks()
	// Telnyx webhook: more specific than the generic /api/integrations catch-all, so mounted first.
	app.route('/api/integrations/telnyx/webhook', integrationsTelnyxWebhookRoutes)
	app.route('/api/integrations/telnyx/tools', integrationsTelnyxToolsRoutes)
	// google-drive MCP surface — same ordering constraint as google-meet's above.
	app.route('/api/integrations/google-drive/mcp', integrationsGoogleDriveMcpRoutes)
	app.route('/api/integrations/google', integrationsGoogleDisconnectRoutes)
	// folder watches list + stop for the Drive detail page; its own prefix, so the
	// generic /api/integrations/{provider}/... routes never see these paths.
	app.route('/api/integrations/google-drive', integrationsGoogleDriveRoutes)
	app.route('/api/integrations/google-search-console/mcp', integrationsGoogleSearchConsoleMcpRoutes)
	app.route('/api/custom-mcp-servers', customMcpServersRoutes)
	app.route('/api/integrations', integrationsKeychainRoutes)
	app.route('/api/keychain', keychainAdminRoutes)
	app.route('/api/integrations', integrationsGrantsRoutes)
	app.route('/api/integrations', integrationsGatewayRoutes)
	// Gmail send (the gmail_send_email tool's route), before the generic catch-all.
	app.route('/api/integrations/gmail', integrationsGmailRoutes)
	app.route('/api/integrations', integrationsRoutes)
	app.route('/api/integrations/slack/mcp', integrationsSlackMcpRoutes)
	// Stripe webhook mounted at /api/webhooks/stripe BEFORE the integrations
	// catchall (`/api/webhooks/:provider`) so the more-specific match wins.
	// Stripe is billing, not an integration provider.
	app.route('/api/webhooks/stripe', stripeWebhookRoutes)
	app.route('/api/marketplace', marketplaceLoopsRoutes)
	app.route('/api/mini-apps', miniAppRegenRoutes)
	app.route('/api/webhooks', webhookApp)
	app.route('/api/billing', billingRoutes)
	// Only exists on stacks that set MASKIN_TEST_GRANT_TOKEN (CI's E2E run).
	// Unmounted — not merely guarded — everywhere else, so production 404s.
	if (isTestGrantEnabled()) {
		app.route('/api/test-grants', testGrantsRoutes)
	}
	app.route('/api/internal/agent-servers', agentServerReconcileRoutes)
	app.route('/api/internal/mcp-guard', mcpGuardRoutes)
	app.route('/api/events', eventsRoutes)
	app.route('/api/conversations', conversationsRoutes)
	app.route('/api/search', searchRoutes)
	app.route('/api/sessions', sessionsRoutes)
	app.route('/api/notifications', notificationsRoutes)
	app.route('/api/for-you', forYouRoutes)
	app.route('/api/devices', devicesRoutes)
	app.route('/api/notification-preferences', notificationPreferencesRoutes)
	app.route('/api/live-activities', liveActivitiesRoutes)
	app.route('/api/web-push', webPushRoutes)
	app.route('/api/subscriptions', subscriptionsRoutes)
	app.route('/api/graph', graphRoutes)
	app.route('/api/imports', importsRoutes)
	app.route('/api/installed-loops', installedLoopsRoutes)
	app.route('/api/files', filesRoutes)
	// Mounted at the same prefix — Hono composes multiple sub-apps at one
	// prefix so the nested /:id/comments paths sit under the existing files
	// surface without touching files.ts.
	app.route('/api/files', fileCommentsRoutes)
	app.route('/api/extensions', extensionsRoutes)
	app.route('/api/claude-oauth', claudeOauthRoutes)
	app.route('/api/telemetry', telemetryRoutes)
	app.route('/api/user-display-settings', userDisplaySettingsRoutes)
	app.route('/api/feature-flags', featureFlagsRoutes)
	app.route('/api/desktop', desktopRoutes)
	// app.route('/api/desktop/teach', desktopTeachRoutes)
	app.route('/api/voice-sessions', voiceSessionsRoutes)
	app.route('/api/transcriptions', transcriptionsRoutes)

	if (options.includeExtensions !== false) {
		const moduleEnv = { db, notifyBridge, sessionManager, agentStorage, storageProvider }
		for (const ext of getAllModules()) {
			if (ext.routes) {
				try {
					app.route(`/api/m/${ext.id}`, ext.routes(moduleEnv))
				} catch (err) {
					logger.error('Failed to mount extension routes', {
						extensionId: ext.id,
						error: String(err),
						stack: err instanceof Error ? err.stack : undefined,
					})
				}
			}
		}
	}

	app.route('/mcp', mcpRoutes)

	// Public method-site routes — mounted BEFORE the SPA static fallthrough
	// below so `/method/*` never falls through to `index.html`. The editorial
	// layer inlines the `method_site_pageview` script from
	// `lib/analytics/method-site-pageview` in every rendered page so T2's
	// ship metric keeps firing.
	app.route('/method', methodRoutes)

	// Universal links for the native app. Served here (not from web/dist) so the SPA catch-all
	// below can never shadow it. 404 until APPLE_TEAM_ID is set, so nothing is advertised half-configured.
	app.get('/.well-known/apple-app-site-association', (c) => {
		const body = buildAppleAppSiteAssociation(process.env.APPLE_TEAM_ID)
		if (!body) return c.json(createApiError('NOT_FOUND', 'Not configured'), 404)
		return c.body(JSON.stringify(body), 200, { 'Content-Type': 'application/json' })
	})

	app.doc31('/api/openapi.json', getOpenApiConfig(port))

	const staticDir =
		options.staticDir ??
		process.env.STATIC_DIR ??
		path.resolve(import.meta.dirname ?? __dirname, '../../web/dist')
	if (fs.existsSync(staticDir)) {
		logger.info(`Serving static files from ${staticDir}`)
		app.use(
			'*',
			serveStatic({
				root: path.relative(process.cwd(), staticDir),
			}),
		)
		app.get('*', (c) => {
			// A path under /assets/ or /fonts/, or one naming a static file, is a missing file
			// rather than a client route. Answering it with index.html and a 200 lets a CDN cache
			// HTML under a .js URL (Cloudflare caches by extension, 4h), so every browser that loads
			// the module script gets "MIME type of text/html" and a blank page until it expires.
			// This happens when a request for a new bundle lands before the new build is live.
			if (STATIC_FILE_PATH_RE.test(c.req.path)) {
				c.header('Cache-Control', 'no-store')
				return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
			}
			try {
				const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf-8')
				return c.html(html)
			} catch {
				return c.json(createApiError('NOT_FOUND', 'Page not found'), 404)
			}
		})
	}

	return app
}
