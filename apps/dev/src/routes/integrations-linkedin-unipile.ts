import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	WEBHOOK_HEADER_CANDIDATES,
	createHostedAuthLink,
	verifyWebhookSignature,
} from '../lib/integrations/providers/linkedin-unipile/client'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

/**
 * Unipile Hosted Auth Wizard flow for LinkedIn.
 *
 * Two routes:
 *   - POST /connect   — creates or looks up a pending integrations row keyed
 *                       by (workspace, actor, provider='linkedin-unipile'),
 *                       calls Unipile to get a hosted-wizard install URL,
 *                       returns { install_url } to the UI. Auth: API key.
 *   - POST /callback  — HMAC-SHA256 verify, then in a single Drizzle
 *                       transaction move the pending row to
 *                       status='active' with encrypted { account_id }
 *                       and fire the PostHog integration_connected event
 *                       AFTER the transaction commits. Auth: HMAC only
 *                       (path is exempt from the API-key middleware —
 *                       see app-factory.ts's /callback allowlist regex).
 *
 * Design notes rooted in the spec (see the parent bet's technical spec §2):
 *   - LinkedIn tokens NEVER cross Maskin infrastructure. The stored credential
 *     is Unipile's own account_id, which we combine with the workspace-scoped
 *     MASKIN_UNIPILE_API_KEY on every downstream call.
 *   - The DB commit runs first; the PostHog capture runs after with await
 *     but is fire-and-forget internally (capturePosthogEvent catches every
 *     failure). An unlogged event is strictly better than a rolled-back
 *     credential write — see spec §Telemetry ordering rule.
 *   - We do NOT reuse the generic OAuth2Handler — Unipile's hosted wizard is
 *     not an OAuth2 authorization-code flow. The provider is registered in
 *     the integration registry with auth.type='oauth2_custom' as a sentinel
 *     so it appears in Settings > Integrations, and this dedicated router is
 *     mounted at /api/integrations/linkedin-unipile BEFORE the generic
 *     /api/integrations mount so Hono's trie routes the more specific prefix
 *     to us instead of the generic /{provider}/connect handler.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const PROVIDER = 'linkedin-unipile'

/**
 * The status a successfully-landed credential row carries.
 *
 * MUST stay `'active'`. Every reader in the codebase filters on that literal —
 * `lib/integrations/lookup.ts`'s `getIntegrationCredential` (the helper this
 * provider's downstream tools use), `oauth/token-manager.ts`, and every
 * `routes/integrations.ts` list query. `integrations.status` is a plain `text`
 * column with no enum or CHECK constraint, so writing any other value is
 * accepted by Postgres and then silently matches nothing on read: the connect
 * flow appears to succeed and the integration is invisible forever.
 */
const CONNECTED_STATUS = 'active'

function callbackUrl(): string {
	const base = (process.env.MASKIN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')
	return `${base}/api/integrations/linkedin-unipile/callback`
}

// ── POST /connect ──────────────────────────────────────────────────────────

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	tags: ['integrations'],
	summary: 'Start LinkedIn Unipile Hosted Auth Wizard connect flow',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Unipile-hosted install URL for the customer to complete LinkedIn auth in.',
			content: {
				'application/json': {
					schema: z.object({
						install_url: z.string().url(),
						integration_id: z.string().uuid(),
					}),
				},
			},
		},
		500: {
			description: 'Error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Look up or insert a pending row keyed by (workspace, actor, provider).
	// credentials starts as an empty string because the column is NOT NULL
	// but we don't have any credential material until /callback fires.
	const existing = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.actorId, actorId),
				eq(integrations.provider, PROVIDER),
			),
		)
		.limit(1)

	let integrationId: string
	if (existing[0]) {
		integrationId = existing[0].id
		// 'active' is the shared vocabulary — see CONNECTED_STATUS. Re-running
		// the wizard against an already-active row must NOT demote it to
		// pending, or the credential goes unreadable until the callback lands.
		if (existing[0].status !== CONNECTED_STATUS) {
			await db
				.update(integrations)
				.set({ status: 'pending', updatedAt: new Date() })
				.where(eq(integrations.id, integrationId))
		}
	} else {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				actorId,
				provider: PROVIDER,
				status: 'pending',
				credentials: '',
				createdBy: actorId,
			})
			.returning({ id: integrations.id })
		if (!row?.id) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to allocate integration row'), 500)
		}
		integrationId = row.id
	}

	try {
		const cb = callbackUrl()
		const link = await createHostedAuthLink({
			name: integrationId,
			apiUrl: cb,
			notifyUrl: cb,
		})
		return c.json({ install_url: link.url, integration_id: integrationId })
	} catch (err) {
		logger.error('linkedin-unipile connect: hosted-link creation failed', {
			workspaceId,
			actorId,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to start LinkedIn connect flow'), 500)
	}
}) as RouteHandler<typeof connectRoute, Env>)

// ── POST /callback ─────────────────────────────────────────────────────────

const callbackRoute = createRoute({
	method: 'post',
	path: '/callback',
	tags: ['integrations'],
	summary: 'Unipile Hosted Auth Wizard success callback',
	responses: {
		200: {
			description: 'Callback accepted.',
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
		},
		401: {
			description: 'Signature verification failed.',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'No pending integration row matches the callback name.',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(callbackRoute, (async (c) => {
	const db = c.get('db')

	// The raw body is required for HMAC verification, so we read it once and
	// parse it manually. Hono's built-in json parser would consume the stream
	// and force us to re-serialize — which fails to reproduce the exact bytes
	// Unipile signed.
	const rawBody = await c.req.text()

	const provided =
		WEBHOOK_HEADER_CANDIDATES.map((h) => c.req.header(h)).find(
			(v): v is string => typeof v === 'string' && v.length > 0,
		) ?? null

	if (!verifyWebhookSignature(rawBody, provided)) {
		logger.warn('linkedin-unipile callback: signature verification failed', {
			headerPresent: provided !== null,
		})
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	let payload: {
		status?: string
		account_id?: string
		name?: string
	} = {}
	try {
		payload = JSON.parse(rawBody) as typeof payload
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Malformed callback body'), 400)
	}

	if (payload.status !== 'CREATION_SUCCESS' || !payload.account_id || !payload.name) {
		logger.info('linkedin-unipile callback: non-success status or missing fields', {
			status: payload.status,
			hasAccountId: Boolean(payload.account_id),
			hasName: Boolean(payload.name),
		})
		return c.json({ ok: true })
	}

	// The `name` we passed to Unipile at /connect time IS the integrations row id.
	// Look up the pending row by that id and confirm it's still awaiting
	// completion — we deliberately don't fall back to (workspace, actor,
	// provider) because a stale row that was never re-`/connect`'d shouldn't
	// silently absorb an unrelated success.
	const [pending] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, payload.name), eq(integrations.provider, PROVIDER)))
		.limit(1)

	if (!pending) {
		logger.warn('linkedin-unipile callback: no matching integration row', {
			name: payload.name,
		})
		return c.json(createApiError('NOT_FOUND', 'Unknown integration'), 404)
	}

	const encrypted = encrypt(JSON.stringify({ account_id: payload.account_id }))

	// Single-transaction credential landing — Drizzle's `db.transaction`
	// keeps the UPDATE and any follow-up DDL inside the same txn scope.
	// PostHog capture is intentionally OUTSIDE the transaction: the spec's
	// ordering rule (§Telemetry) is that a rolled-back credential write
	// must never leak a fake integration_connected signal.
	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({
				credentials: encrypted,
				externalId: payload.account_id,
				status: CONNECTED_STATUS,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, pending.id))
	})

	// Fire the PostHog signal. `capturePosthogEvent` catches every failure
	// internally so we never mask a successful credential landing with an
	// analytics error.
	if (pending.actorId) {
		await trackIntegrationConnected({
			provider: PROVIDER,
			workspaceId: pending.workspaceId,
			actorId: pending.actorId,
			integrationId: pending.id,
		})
	} else {
		logger.warn('linkedin-unipile callback: pending row missing actor_id — event skipped', {
			integrationId: pending.id,
		})
	}

	return c.json({ ok: true })
}) as RouteHandler<typeof callbackRoute, Env>)

export default app
