import { createMcpServer } from '@maskin/mcp'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'

const app = new Hono()

// ─── Stateful session store ──────────────────────────────
// Maps session IDs to their transport + server instances for persistent connections.
// Enables SSE push, elicitation, and progress notifications across requests.
const sessions = new Map<
	string,
	{
		transport: StreamableHTTPServerTransport
		server: ReturnType<typeof createMcpServer>
		lastActivity: number
	}
>()

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes idle timeout

function cleanupStaleSessions() {
	const now = Date.now()
	for (const [id, session] of sessions) {
		if (now - session.lastActivity > SESSION_TTL_MS) {
			void session.transport.close()
			sessions.delete(id)
		}
	}
}

// Run cleanup every 5 minutes
const cleanupInterval = setInterval(cleanupStaleSessions, 5 * 60 * 1000)
cleanupInterval.unref?.()

app.post('/', async (c) => {
	const sessionId = c.req.header('mcp-session-id')

	const nodeRes = (c.env as Record<string, unknown>).outgoing as import('node:http').ServerResponse
	const nodeReq = (c.env as Record<string, unknown>).incoming as import('node:http').IncomingMessage

	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}

	const method =
		(body as Record<string, unknown>)?.method ??
		(Array.isArray(body) ? body.map((b: { method?: string }) => b.method) : 'unknown')

	// Reuse existing session if available
	const existingSession = sessionId ? sessions.get(sessionId) : undefined
	if (existingSession) {
		existingSession.lastActivity = Date.now()
		console.log(`[MCP] POST /mcp — session: ${sessionId}, method: ${JSON.stringify(method)}`)
		await existingSession.transport.handleRequest(nodeReq, nodeRes, body)

		return new Response(null, {
			headers: { 'x-hono-already-sent': '1' },
		})
	}

	// Create new session
	const mcpConfig = {
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		apiKey:
			c.req.header('Authorization')?.replace('Bearer ', '') ??
			new URL(c.req.url, 'http://localhost').searchParams.get('key') ??
			'',
		defaultWorkspaceId:
			c.req.header('X-Workspace-Id') ??
			new URL(c.req.url, 'http://localhost').searchParams.get('workspace') ??
			'',
	}
	const mcpServer = createMcpServer(mcpConfig)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => crypto.randomUUID(),
		enableJsonResponse: true,
	})

	await mcpServer.connect(transport)

	// Store the session for reuse
	const newSessionId = transport.sessionId
	if (newSessionId) {
		sessions.set(newSessionId, {
			transport,
			server: mcpServer,
			lastActivity: Date.now(),
		})
		console.log(`[MCP] POST /mcp — new session: ${newSessionId}, method: ${JSON.stringify(method)}`)
	} else {
		console.log(`[MCP] POST /mcp — stateless request, method: ${JSON.stringify(method)}`)
	}

	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, {
		headers: { 'x-hono-already-sent': '1' },
	})
})

// SSE endpoint for server-initiated messages (notifications, progress, elicitation)
app.get('/', async (c) => {
	const sessionId = c.req.header('mcp-session-id')
	const session = sessionId ? sessions.get(sessionId) : undefined
	if (!session) {
		return c.text('Session not found. Send a POST request first to initialize.', 404)
	}

	session.lastActivity = Date.now()

	const nodeRes = (c.env as Record<string, unknown>).outgoing as import('node:http').ServerResponse
	const nodeReq = (c.env as Record<string, unknown>).incoming as import('node:http').IncomingMessage

	console.log(`[MCP] GET /mcp — SSE stream for session: ${sessionId}`)
	await session.transport.handleRequest(nodeReq, nodeRes)

	return new Response(null, {
		headers: { 'x-hono-already-sent': '1' },
	})
})

// DELETE to terminate a session
app.delete('/', async (c) => {
	const sessionId = c.req.header('mcp-session-id')
	const deleteSession = sessionId ? sessions.get(sessionId) : undefined
	if (deleteSession) {
		void deleteSession.transport.close()
		sessions.delete(sessionId as string)
		console.log(`[MCP] DELETE /mcp — session terminated: ${sessionId}`)
		return c.text('Session terminated', 200)
	}
	return c.text('Session not found', 404)
})

export default app
