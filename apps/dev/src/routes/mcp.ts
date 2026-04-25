import { createMcpServer } from '@maskin/mcp'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'

const app = new Hono()

app.post('/', async (c) => {
	const url = new URL(c.req.url, 'http://localhost')
	const mcpConfig = {
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		apiKey:
			c.req.header('Authorization')?.replace('Bearer ', '') ?? url.searchParams.get('key') ?? '',
		defaultWorkspaceId: c.req.header('X-Workspace-Id') ?? url.searchParams.get('workspace') ?? '',
		transport: 'http' as const,
		webAppBaseUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
	}
	const mcpServer = createMcpServer(mcpConfig)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

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
	console.log(`[MCP] POST /mcp — method: ${JSON.stringify(method)}`)
	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	// transport.handleRequest already wrote the response to nodeRes.
	// Signal @hono/node-server to skip writing headers again.
	return new Response(null, {
		headers: { 'x-hono-already-sent': '1' },
	})
})

// Reject GET/DELETE on /mcp — server doesn't support server-initiated SSE streams
app.get('/', (c) => {
	return c.text('Method Not Allowed', 405)
})

app.delete('/', (c) => {
	return c.text('Method Not Allowed', 405)
})

export default app
