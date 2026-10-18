import { readFileSync, readdirSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

// Wire-level harness for the legacy (SDK v1) /mcp transcripts. It runs the REAL
// route, the real createMcpServer and the real SDK transport behind a real
// node http server, with only the Maskin API behind the tool handlers
// stubbed. Nothing in the path is mocked, so the status, content-type and body
// a client sees are exactly what the SDK wrote.
//
// Two consumers share it: the one-off recording of the fixtures from v1 main,
// and the replay test that pins them. The fixtures are self-contained (they
// hold the request they were recorded from), so the replay never depends on
// the case list below.

export const FIXTURE_API_KEY = 'ank_fixture'
export const FIXTURE_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa'

export interface RecordedRequest {
	method: 'GET' | 'POST' | 'DELETE'
	headers: Record<string, string>
	/** Raw request body, sent verbatim. Absent for GET and DELETE. */
	body?: string
}

export interface RecordedResponse {
	status: number
	contentType: string | null
	/** Raw response body text, byte for byte. */
	body: string
}

export interface LegacyTranscript {
	name: string
	description: string
	request: RecordedRequest
	response: RecordedResponse
}

// The one workspace the stubbed API returns. No createdAt/updatedAt on purpose:
// list_workspaces turns those into a relative age ("3d ago") that would make
// the recorded body drift with the calendar.
const STUB_WORKSPACES = [{ id: FIXTURE_WORKSPACE_ID, name: 'Fixture workspace', role: 'owner' }]

export interface LegacyWireServer {
	/** Base URL of the /mcp route, e.g. http://127.0.0.1:41234/mcp */
	url: string
	close(): Promise<void>
}

export async function startLegacyWireServer(): Promise<LegacyWireServer> {
	// Stub of the Maskin API the tool handlers call back into. Reads return the
	// fixed workspace list or an empty array; the fire-and-forget telemetry POST
	// is acknowledged and ignored.
	const apiServer: Server = createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json')
		if (req.method === 'GET' && req.url?.startsWith('/api/workspaces')) {
			res.end(JSON.stringify(STUB_WORKSPACES))
			return
		}
		res.end(req.method === 'GET' ? '[]' : '{}')
	})
	const apiPort = await listen(apiServer)

	// The route builds its server with apiBaseUrl from PORT, and the web base
	// URL (echoed in every tool response's _meta) from these two. Pin them for
	// the lifetime of the harness and put them back on close.
	const saved = {
		PORT: process.env.PORT,
		WEB_APP_URL: process.env.WEB_APP_URL,
		FRONTEND_URL: process.env.FRONTEND_URL,
	}
	process.env.PORT = String(apiPort)
	Reflect.deleteProperty(process.env, 'WEB_APP_URL')
	process.env.FRONTEND_URL = 'http://localhost:5173'

	const { default: mcpRoutes } = await import('../routes/mcp')
	const app = new Hono()
	app.route('/mcp', mcpRoutes)

	const mcpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server
	await new Promise<void>((resolve) => mcpServer.once('listening', () => resolve()))
	const mcpPort = (mcpServer.address() as AddressInfo).port

	return {
		url: `http://127.0.0.1:${mcpPort}/mcp`,
		async close() {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) Reflect.deleteProperty(process.env, key)
				else process.env[key] = value
			}
			await Promise.all([closeServer(mcpServer), closeServer(apiServer)])
		},
	}
}

export async function sendRecordedRequest(
	url: string,
	request: RecordedRequest,
): Promise<RecordedResponse> {
	const res = await fetch(url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
	})
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		body: await res.text(),
	}
}

const BASE_HEADERS = {
	'Content-Type': 'application/json',
	Accept: 'application/json, text/event-stream',
	Authorization: `Bearer ${FIXTURE_API_KEY}`,
	'X-Workspace-Id': FIXTURE_WORKSPACE_ID,
}

function post(payload: unknown): RecordedRequest {
	return {
		method: 'POST',
		headers: { ...BASE_HEADERS },
		body: typeof payload === 'string' ? payload : JSON.stringify(payload),
	}
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
	return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

// Where the recorded transcripts live. They sit with the package under test.
const LEGACY_FIXTURES_DIR = new URL(
	'../../../../packages/mcp/src/__tests__/fixtures/legacy-v1/',
	import.meta.url,
)

export function loadLegacyTranscripts(): LegacyTranscript[] {
	return readdirSync(LEGACY_FIXTURES_DIR)
		.filter((file) => file.endsWith('.json'))
		.sort()
		.map((file) => JSON.parse(readFileSync(new URL(file, LEGACY_FIXTURES_DIR), 'utf8')))
}

// The requests the fixtures were recorded from. Used only by the recording
// step; the replay reads each fixture's own request.
export const LEGACY_CASES: Array<Pick<LegacyTranscript, 'name' | 'description' | 'request'>> = [
	{
		name: 'initialize',
		description: 'Handshake as a 2025-06-18 client sends it.',
		request: post({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'legacy-fixture-client', version: '1.0.0' },
			},
		}),
	},
	{
		name: 'tools-list',
		description: 'tools/list. The tool set itself is pinned by the tools-list golden file.',
		request: post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
	},
	{
		name: 'tools-call-ok',
		description: 'A read tool that succeeds against the stubbed API.',
		request: post(toolCall(3, 'list_workspaces', {})),
	},
	{
		name: 'tools-call-unknown-tool',
		description: 'tools/call for a tool that is not registered.',
		request: post(toolCall(4, 'no_such_tool', {})),
	},
	{
		name: 'tools-call-bad-argument',
		description: 'tools/call with an argument of the wrong type.',
		request: post(toolCall(5, 'list_workspaces', { limit: 'ten' })),
	},
	{
		name: 'tools-call-unrecognized-key',
		description: 'tools/call whose strict step "when" carries a key the schema does not allow.',
		request: post(
			toolCall(6, 'create_loop', {
				workspace_id: FIXTURE_WORKSPACE_ID,
				name: 'Fixture loop',
				steps: [
					{
						name: 'Step',
						agent_id: '00000000-0000-4000-8000-0000000000bb',
						prompt: 'Do the thing',
						when: { cron: '*/5 * * * *', not_a_field: true },
					},
				],
			}),
		),
	},
	{
		name: 'notification',
		description: 'A JSON-RPC notification, which has no id and expects no body back.',
		request: post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
	},
	{
		name: 'batch-array',
		description: 'A JSON-RPC batch posted as an array.',
		request: post([
			{ jsonrpc: '2.0', id: 7, method: 'tools/list' },
			toolCall(8, 'list_workspaces', {}),
		]),
	},
	{
		name: 'get',
		description: 'GET on the route.',
		request: { method: 'GET', headers: { Authorization: `Bearer ${FIXTURE_API_KEY}` } },
	},
	{
		name: 'delete',
		description: 'DELETE on the route.',
		request: { method: 'DELETE', headers: { Authorization: `Bearer ${FIXTURE_API_KEY}` } },
	},
	{
		name: 'malformed-json',
		description: 'A POST whose body is not JSON.',
		request: post('{"jsonrpc": "2.0", "id": 9, "method": '),
	},
]

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
	})
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve())
		server.closeAllConnections()
	})
}
