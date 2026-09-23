import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import type { Database } from '@maskin/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/integrations/providers/linkedin-unipile/mcp-registry-self-heal', () => ({
	selfHealLinkedInMcpCredential: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn().mockResolvedValue(true),
}))

/**
 * Regression pin for the workspace-scope of the fan-out credential lookup.
 *
 * Sessions run under the AGENT actor's Maskin API key
 * (services/session-manager.ts sets envVars.MASKIN_API_KEY = agent.apiKey),
 * and agents never connect their own LinkedIn — humans do. An earlier
 * version of this route filtered `integrations` rows by
 * `eq(integrations.actorId, actorId)` where `actorId` was the CALLING
 * actor's id, which meant every agent call returned zero credential rows
 * and therefore zero fan-out tools even after LinkedIn was connected in
 * the workspace and autoInject wired up the MCP server url.
 *
 * Identity disambiguation happens at the TOOL level, not the credential
 * level: every registered identity is served as its own MCP instance
 * (`linkedin-{unipileAccSlug}-{identitySlug}`) with a scoped tool name
 * and an "AS <displayName>" description. Workspace membership
 * (`isWorkspaceMember` at the top of the route) is the auth boundary,
 * same as slack's MCP.
 *
 * This test reads the route source directly and asserts the where-clause
 * has NOT re-acquired the actor filter. It intentionally does not go
 * through the streamable-http transport — the fault mode we are guarding
 * against is a one-line predicate regression, and a source-level pin
 * catches it deterministically without the transport plumbing.
 */
describe('linkedin-unipile MCP route — credential lookup shape', () => {
	const ROUTE_SRC = readFileSync(
		resolve(__dirname, '../integrations-linkedin-unipile-mcp.ts'),
		'utf8',
	)

	it('queries integrations rows by workspace + provider, without an actorId filter', () => {
		const whereMatch = ROUTE_SRC.match(/\.where\([\s\S]+?\)\s*\n/)
		expect(whereMatch, 'route must have a .where(...) clause').not.toBeNull()

		const whereClause = whereMatch?.[0] ?? ''

		// Positive assertions — the two predicates that must be present.
		expect(whereClause).toContain('workspaceId')
		expect(whereClause).toContain('provider')

		// Negative assertion — the predicate that must NOT come back. Matching
		// on `integrations.actorId` specifically so a substring like "actorId"
		// used elsewhere on the module (context binding, log fields) does not
		// false-trip this. Any qualified reference to the row's actor id would
		// re-introduce the agent-empty-tools bug.
		expect(whereClause).not.toContain('integrations.actorId')
	})
})

/**
 * Regression pin for the deprecated aggregate route's RESPONSE shape.
 *
 * P3-K reshaped the LinkedIn MCP surface into one endpoint per identity
 * (`.../mcp/{instanceSlug}`) and kept the aggregate URL (`.../mcp`) live
 * as a backwards-compat landing pad — its documented behavior was "empty
 * tool set." But the MCP SDK (1.29.0, `server/mcp.js`) only wires the
 * `tools` capability and the `tools/list` + `tools/call` handlers via
 * `setToolRequestHandlers`, which is gated behind `_createRegisteredTool`.
 * A server with zero registered tools therefore advertised
 * `capabilities:{}` and answered every `tools/list` (and `tools/call`) with
 * `-32601 Method not found` — an unexplained error that flat-out contradicted
 * the route's own doc.
 *
 * The de-trap wires the tools/list + tools/call handlers directly on the
 * low-level `Server` so the aggregate route serves a real JSON-RPC response
 * — an empty tools list on list, and a deprecation-pointer error on call
 * that names the per-identity URL and the identities endpoint. This test
 * boots the route over a real HTTP server and hits it end-to-end with real
 * JSON-RPC bodies (initialize → tools/list → tools/call), because the fault
 * mode lives specifically in the SDK's dispatch layer — a mocked transport
 * would miss it entirely, and a source-level regex would only see the two
 * new `setRequestHandler` calls without proving they actually answer.
 *
 * If this test ever goes red with a `-32601 Method not found` body, the SDK
 * upgrade or a refactor of `apps/dev/src/routes/integrations-linkedin-unipile-mcp.ts`
 * has re-armed the trap.
 */
describe('linkedin-unipile MCP route — deprecated aggregate response', () => {
	const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
	const ACTOR_ID = '22222222-2222-4222-8222-222222222222'

	let server: ReturnType<typeof serve>
	let baseUrl: string

	beforeAll(async () => {
		const { OpenAPIHono } = await import('@hono/zod-openapi')
		const { default: mcpRoutes } = await import('../integrations-linkedin-unipile-mcp')
		const { createTestContext } = await import('../../__tests__/setup')

		const { db, mockResults } = createTestContext()
		// The aggregate route calls `resolveWorkspaceIdentities` inside the per-
		// identity handler only; the deprecated `/` handler bypasses that and
		// hits the MCP SDK directly with zero instances. But the top-level
		// workspace-membership check still runs — mocked above so this test does
		// not depend on real workspace_members rows. The select-queue is empty
		// because no DB call reaches through to it on the deprecated path.
		mockResults.selectQueue = []

		// Freestanding OpenAPIHono for the boot; the route module's Env is
		// re-declared on the anonymous middleware below so `c.set` typechecks
		// without pulling the real Env from setup.ts (which drags PgNotifyBridge
		// and SessionManager into the test surface for no reason).
		const app = new OpenAPIHono<{
			Variables: { db: Database; actorId: string; actorType: string }
		}>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', ACTOR_ID)
			c.set('actorType', 'human')
			await next()
		})
		app.route('/', mcpRoutes)

		server = serve({ fetch: app.fetch, port: 0 })
		await new Promise<void>((resolveReady) => {
			server.on('listening', () => resolveReady())
			if (server.listening) resolveReady()
		})
		const addr = server.address() as AddressInfo
		baseUrl = `http://127.0.0.1:${addr.port}`
	})

	afterAll(async () => {
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close((err) => (err ? rejectClose(err) : resolveClose())),
		)
	})

	function jsonRpc(method: string, params?: unknown, id: number | string = 1) {
		return { jsonrpc: '2.0' as const, id, method, params }
	}

	async function postRpc(body: unknown) {
		const res = await fetch(`${baseUrl}/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify(body),
		})
		const text = await res.text()
		return { res, text }
	}

	it('answers tools/list with an empty tools array — not -32601 Method not found', async () => {
		// `sessionIdGenerator: undefined` on the transport means each POST is
		// its own stateless session — the SDK short-circuits the initialize
		// handshake and dispatches the method directly. This is the exact
		// shape a hand-wired client hitting the deprecated aggregate URL sees.
		const { res, text } = await postRpc(jsonRpc('tools/list', {}, 2))
		expect(res.status, `tools/list response: ${text}`).toBe(200)

		const body = JSON.parse(text) as {
			jsonrpc: string
			id: number
			result?: { tools: unknown[] }
			error?: { code: number; message: string }
		}

		expect(
			body.error,
			`tools/list must not return a JSON-RPC error — got ${JSON.stringify(body.error)}. The deprecated aggregate route regressed to the pre-de-trap "-32601 Method not found" trap; see routes/integrations-linkedin-unipile-mcp.ts.`,
		).toBeUndefined()
		expect(body.result).toBeDefined()
		expect(body.result?.tools).toEqual([])
	})

	it('answers tools/call with a deprecation error that names the per-identity route', async () => {
		const { res, text } = await postRpc(
			jsonRpc('tools/call', { name: 'linkedin_send_message', arguments: {} }, 3),
		)
		expect(res.status, `tools/call response: ${text}`).toBe(200)

		const body = JSON.parse(text) as {
			jsonrpc: string
			id: number
			result?: { isError?: boolean; content?: Array<{ type: string; text: string }> }
			error?: { code: number; message: string }
		}

		// The deprecated route must NOT hand back a bare -32601 — that is the
		// exact silent trap the de-trap exists to close.
		expect(body.error).toBeUndefined()
		expect(body.result?.isError).toBe(true)

		const errorText = body.result?.content?.[0]?.text ?? ''
		// The wire-code lets an agent branch on it and lets Sentry group on it.
		expect(errorText).toContain('LINKEDIN_MCP_DEPRECATED_AGGREGATE')
		// The migration recipe: per-identity URL shape + the identities endpoint
		// slugs come from. If either drops out of the message, the operator
		// reading the transcript loses the one-step fix.
		expect(errorText).toContain('/api/integrations/linkedin-unipile/mcp/{instanceSlug}')
		expect(errorText).toContain('/api/integrations/linkedin-unipile/identities')
	})
})
