import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, authBrowserSessions, integrations } from '@maskin/db/schema'
import CDP from 'chrome-remote-interface'
import { and, eq } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import type { AuthBrowserManager } from '../services/auth-browser-manager'

const PROVIDER = 'linkedin'
const COOKIE_POLL_MS = 2000
const FRAME_FORMAT = 'jpeg' as const
const FRAME_QUALITY = 60
const FRAME_EVERY_NTH = 2
const STREAM_KEEPALIVE_MS = 30_000
/** How long the stream/input routes wait for the container to flip to 'ready'.
 * Covers the 4s Xvfb/Chromium grace + Docker daemon variance. */
const READY_WAIT_MS = 30_000

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		authBrowserManager: AuthBrowserManager
	}
}

const app = new OpenAPIHono<Env>()

// ── POST /linkedin/auth-browser/start ─────────────────────────────────────
// Provisions a new headful Chromium session for the workspace. Returns the
// session id + one-time access token used by the SSE/input routes.
app.post('/linkedin/auth-browser/start', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const mgr = c.get('authBrowserManager')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id header required'), 400)
	}

	try {
		const result = await mgr.startSession({ workspaceId, actorId, provider: PROVIDER })

		// Upsert pending integration row so the integrations page reflects
		// "connecting…" status while the modal is open.
		await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: PROVIDER,
				status: 'pending',
				externalId: result.id,
				credentials: '',
				createdBy: actorId,
			})
			.onConflictDoUpdate({
				target: [integrations.workspaceId, integrations.provider],
				set: { status: 'pending', externalId: result.id, updatedAt: new Date() },
			})

		return c.json({
			id: result.id,
			access_token: result.accessToken,
			expires_at: result.expiresAt.toISOString(),
		})
	} catch (err) {
		return c.json(
			createApiError('BAD_REQUEST', err instanceof Error ? err.message : String(err)),
			400,
		)
	}
})

// ── POST /linkedin/auth-browser/:id/cancel ────────────────────────────────
// User cancellation: tear down the container, mark integration as revoked.
app.post('/linkedin/auth-browser/:id/cancel', async (c) => {
	const db = c.get('db')
	const mgr = c.get('authBrowserManager')
	const id = c.req.param('id')

	const [row] = await db
		.select()
		.from(authBrowserSessions)
		.where(eq(authBrowserSessions.id, id))
		.limit(1)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	await mgr.stopSession(id)

	// If the row carries a workspaceId, revoke any matching pending integration.
	await db
		.update(integrations)
		.set({ status: 'revoked', updatedAt: new Date() })
		.where(
			and(
				eq(integrations.workspaceId, row.workspaceId),
				eq(integrations.provider, PROVIDER),
				eq(integrations.status, 'pending'),
			),
		)

	return c.json({ ok: true })
})

// ── POST /linkedin/auth-browser/:id/:accessToken/input ────────────────────
// Forward a CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent payload.
// The body is the raw CDP params object; type is taken from `?type=` query
// (mouse, key, wheel). Auth is the access token + active row check.
app.post('/linkedin/auth-browser/:id/:accessToken/input', async (c) => {
	const mgr = c.get('authBrowserManager')
	const id = c.req.param('id')
	const accessToken = c.req.param('accessToken')
	const inputType = c.req.query('type')

	// Validate input type before opening CDP so unknown/typo types short-circuit cheaply.
	if (inputType !== 'mouse' && inputType !== 'wheel' && inputType !== 'key') {
		return c.json(createApiError('BAD_REQUEST', `Unknown input type: ${inputType}`), 400)
	}

	const endpoint = await mgr.getCdpEndpoint(id, accessToken)
	if (!endpoint) {
		return c.json(createApiError('BAD_REQUEST', 'Session not ready or token invalid'), 400)
	}

	const body = await c.req.json().catch(() => null)
	if (!body || typeof body !== 'object') {
		return c.json(createApiError('BAD_REQUEST', 'Body must be a JSON object'), 400)
	}

	let client: Awaited<ReturnType<typeof CDP>> | null = null
	try {
		client = await CDP({ host: endpoint.host, port: endpoint.port })
		// The frontend sends CDP-shape payloads as-is; we don't validate every field.
		// biome-ignore lint/suspicious/noExplicitAny: trust the client-shaped CDP body
		const params = body as any
		if (inputType === 'mouse' || inputType === 'wheel') {
			await client.Input.dispatchMouseEvent(params)
		} else {
			await client.Input.dispatchKeyEvent(params)
		}
		return c.body(null, 204)
	} catch (err) {
		logger.warn('Auth browser input dispatch failed', { id, error: String(err) })
		return c.json(
			createApiError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)),
			500,
		)
	} finally {
		if (client) await client.close().catch(() => {})
	}
})

// ── GET /linkedin/auth-browser/:id/:accessToken/stream ────────────────────
// SSE stream: Page.startScreencast frames + status events ('captured' | 'expired' | 'error').
// Also polls Network.getAllCookies every 2s — when li_at appears, finalizes
// the integration row, encrypts the credentials, and closes the stream.
app.get('/linkedin/auth-browser/:id/:accessToken/stream', async (c) => {
	const db = c.get('db')
	const mgr = c.get('authBrowserManager')
	const id = c.req.param('id')
	const accessToken = c.req.param('accessToken')

	// The frontend opens this stream immediately after /start returns, but
	// provisioning runs in the background (~4-8 s for Xvfb + Chromium). Wait
	// for the row to flip to 'ready' rather than 400ing on the first attempt.
	const endpoint = await mgr.waitForReady(id, accessToken, READY_WAIT_MS)
	if (!endpoint) {
		return c.json(createApiError('BAD_REQUEST', 'Session not ready or token invalid'), 400)
	}

	const [sessionRow] = await db
		.select()
		.from(authBrowserSessions)
		.where(eq(authBrowserSessions.id, id))
		.limit(1)
	if (!sessionRow) {
		return c.json(createApiError('NOT_FOUND', 'Session row missing'), 404)
	}

	return streamSSE(c, async (stream) => {
		let client: Awaited<ReturnType<typeof CDP>> | null = null
		let pollInterval: NodeJS.Timeout | null = null
		let captured = false

		const cleanup = async () => {
			if (pollInterval) {
				clearInterval(pollInterval)
				pollInterval = null
			}
			if (client) {
				await client.close().catch(() => {})
				client = null
			}
		}

		stream.onAbort(() => {
			void cleanup()
		})

		try {
			client = await CDP({ host: endpoint.host, port: endpoint.port })
			const { Page, Network } = client
			await Page.enable()
			await Network.enable()

			// Forward screencast frames. CRI's Domain.event(callback) returns a disposer.
			Page.screencastFrame(async (params) => {
				try {
					await stream.writeSSE({ event: 'frame', data: params.data })
					await Page.screencastFrameAck({ sessionId: params.sessionId }).catch(() => {})
				} catch (err) {
					logger.warn('Frame forward failed', { id, error: String(err) })
				}
			})

			await Page.startScreencast({
				format: FRAME_FORMAT,
				quality: FRAME_QUALITY,
				everyNthFrame: FRAME_EVERY_NTH,
			})

			// Cookie polling — finalize the integration when li_at appears.
			pollInterval = setInterval(async () => {
				if (captured || !client) return
				try {
					const { cookies } = await client.Network.getAllCookies()
					const liAt = cookies.find((c) => c.name === 'li_at' && c.domain.endsWith('linkedin.com'))
					if (!liAt) return
					const jsessionidCookie = cookies.find(
						(c) => c.name === 'JSESSIONID' && c.domain.endsWith('linkedin.com'),
					)

					const provider = getProvider(PROVIDER)
					if (!provider.customAuth) {
						throw new Error('LinkedIn provider has no customAuth handler')
					}
					const callbackParams: Record<string, string> = { li_at: liAt.value }
					if (jsessionidCookie) {
						// LinkedIn's JSESSIONID arrives quoted (e.g. "ajax:..."); strip the quotes.
						callbackParams.jsessionid = jsessionidCookie.value.replace(/^"|"$/g, '')
					}
					const credentials = await provider.customAuth.handleCallback(callbackParams)
					const encrypted = encrypt(JSON.stringify(credentials))

					captured = true

					// Flip the integration row to active.
					await db
						.update(integrations)
						.set({
							status: 'active',
							credentials: encrypted,
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(integrations.workspaceId, sessionRow.workspaceId),
								eq(integrations.provider, PROVIDER),
							),
						)

					// Insert an event so the frontend's useIntegrations query invalidates.
					await db.insert(events).values({
						workspaceId: sessionRow.workspaceId,
						actorId: sessionRow.actorId,
						action: 'integration_connected',
						entityType: 'integration',
						entityId: sessionRow.id,
						data: { provider: PROVIDER },
					})

					// Mark the auth-browser row + tear down the container.
					await mgr.markCaptured(id, encrypted)

					await stream.writeSSE({ event: 'captured', data: JSON.stringify({ provider: PROVIDER }) })
					await cleanup()
				} catch (err) {
					logger.error('Cookie capture failed', { id, error: String(err) })
				}
			}, COOKIE_POLL_MS)

			// Keep the SSE alive until aborted or captured.
			while (!captured) {
				await stream.sleep(STREAM_KEEPALIVE_MS)
				if (Date.now() > sessionRow.expiresAt.getTime()) {
					await stream.writeSSE({ event: 'expired', data: '{}' })
					await cleanup()
					return
				}
			}
		} catch (err) {
			logger.error('Auth browser stream error', { id, error: String(err) })
			await stream
				.writeSSE({
					event: 'error',
					data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
				})
				.catch(() => {})
			await cleanup()
		}
	})
})

export default app
