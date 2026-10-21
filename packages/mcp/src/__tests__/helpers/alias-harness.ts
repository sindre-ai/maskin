import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../server'
import type { TelemetrySink } from '../../telemetry'

// A real McpServer wired to a real MCP client over an in-memory transport, with
// the upstream Maskin API replaced by a local HTTP server that records what the
// tool handlers send it. Nothing in the SDK is mocked, so a call goes through
// the same argument validation a stdio or HTTP caller goes through. That is the
// point: a mock-based test passes even when the alias layer does nothing.

export const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa'

export interface RecordedRequest {
	method: string
	path: string
	body: unknown
	workspace: string | undefined
}

export interface ToolOutcome {
	isError: boolean
	text: string
	requests: RecordedRequest[]
}

export interface AliasHarness {
	client: Client
	listTools(): Promise<Array<{ name: string; inputSchema: unknown }>>
	call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>
	close(): Promise<void>
}

export async function startAliasHarness(
	opts: {
		defaultWorkspaceId?: string
		/** Receives every telemetry event the server emits. Defaults to a no-op. */
		telemetrySink?: TelemetrySink
		/** Answers an API request with this body instead of the empty envelope. */
		respond?: (req: { method: string; path: string }) => unknown
	} = {},
): Promise<AliasHarness> {
	let recorded: RecordedRequest[] = []
	const api: Server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			let body: unknown = null
			try {
				body = raw ? JSON.parse(raw) : null
			} catch {
				body = raw
			}
			recorded.push({
				method: req.method ?? '',
				// snapshot_at is the wall clock, so two otherwise identical calls differ.
				path: (req.url ?? '').replace(/snapshot_at=[^&]*/, 'snapshot_at=<now>'),
				body,
				workspace: req.headers['x-workspace-id'] as string | undefined,
			})
			res.setHeader('content-type', 'application/json')
			const custom = opts.respond?.({ method: req.method ?? '', path: req.url ?? '' })
			if (custom !== undefined) {
				res.end(JSON.stringify(custom))
				return
			}
			// List routes answer with an array, everything else with an empty envelope.
			const isList = req.method === 'GET' && /^\/api\/(objects|sessions)(\?|$)/.test(req.url ?? '')
			res.end(JSON.stringify(isList ? [] : { nodes: [], edges: [], objects: [], sessions: [] }))
		})
	})
	await new Promise<void>((resolve) => api.listen(0, resolve))
	const port = (api.address() as AddressInfo).port

	const server = createMcpServer({
		apiBaseUrl: `http://localhost:${port}`,
		apiKey: 'ank_alias_harness',
		defaultWorkspaceId: opts.defaultWorkspaceId ?? DEFAULT_WORKSPACE_ID,
		telemetrySink: opts.telemetrySink ?? (() => {}),
	})
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'alias-harness', version: '0.0.0' })
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

	return {
		client,
		async listTools() {
			return (await client.listTools()).tools
		},
		async call(name, args) {
			recorded = []
			let isError = false
			let text = ''
			try {
				const result = (await client.callTool({ name, arguments: args })) as {
					isError?: boolean
					content?: Array<{ type: string; text?: string }>
				}
				isError = Boolean(result.isError)
				text = result.content?.find((c) => c.type === 'text')?.text ?? ''
			} catch (err) {
				isError = true
				text = err instanceof Error ? err.message : String(err)
			}
			// Concurrent handler calls land in any order; sort so two runs compare.
			const requests = [...recorded].sort((a, b) =>
				JSON.stringify(a).localeCompare(JSON.stringify(b)),
			)
			return { isError, text, requests }
		},
		async close() {
			await client.close()
			await new Promise<void>((resolve) => api.close(() => resolve()))
		},
	}
}

export const isValidationError = (outcome: ToolOutcome) =>
	outcome.isError && outcome.text.includes('Invalid arguments for tool')

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const WS = DEFAULT_WORKSPACE_ID

export interface RowScenario {
	/** Alias rows this scenario exercises, as "tool oldPath". */
	covers: string[]
	tool: string
	/** Arguments using the old spelling. */
	old: Record<string, unknown>
	/** The same call using the canonical spelling. */
	canonical: Record<string, unknown>
	/** The same call with the aliased field left out. */
	control: Record<string, unknown>
}

const node = { $id: 'a', type: 'task', status: 'todo', title: 'A task' }

export const ROW_SCENARIOS: RowScenario[] = [
	{
		covers: ['list_objects driver_id'],
		tool: 'list_objects',
		old: { workspace_id: WS, driver_id: U1 },
		canonical: { workspace_id: WS, driver: U1 },
		control: { workspace_id: WS },
	},
	{
		covers: ['create_objects nodes.driver_id'],
		tool: 'create_objects',
		old: { workspace_id: WS, nodes: [{ ...node, driver_id: U1 }] },
		canonical: { workspace_id: WS, nodes: [{ ...node, driver: U1 }] },
		control: { workspace_id: WS, nodes: [node] },
	},
	{
		covers: ['create_objects edges.source_id', 'create_objects edges.target_id'],
		tool: 'create_objects',
		old: {
			workspace_id: WS,
			nodes: [node],
			edges: [{ source_id: 'a', target_id: U2, type: 'relates_to' }],
		},
		canonical: {
			workspace_id: WS,
			nodes: [node],
			edges: [{ source: 'a', target: U2, type: 'relates_to' }],
		},
		control: { workspace_id: WS, nodes: [node] },
	},
	{
		covers: ['update_objects updates.driver_id'],
		tool: 'update_objects',
		old: { workspace_id: WS, updates: [{ id: U2, driver_id: U1 }] },
		canonical: { workspace_id: WS, updates: [{ id: U2, driver: U1 }] },
		control: { workspace_id: WS, updates: [{ id: U2 }] },
	},
	{
		covers: ['create_trigger actor_id'],
		tool: 'create_trigger',
		old: {
			workspace_id: WS,
			name: 'Nightly',
			type: 'cron',
			config: { expression: '0 0 * * *' },
			action_prompt: 'Do the thing',
			actor_id: U1,
		},
		canonical: {
			workspace_id: WS,
			name: 'Nightly',
			type: 'cron',
			config: { expression: '0 0 * * *' },
			action_prompt: 'Do the thing',
			target_actor_id: U1,
		},
		control: {
			workspace_id: WS,
			name: 'Nightly',
			type: 'cron',
			config: { expression: '0 0 * * *' },
			action_prompt: 'Do the thing',
		},
	},
	{
		covers: ['update_trigger actor_id'],
		tool: 'update_trigger',
		old: { workspace_id: WS, id: U2, actor_id: U1 },
		canonical: { workspace_id: WS, id: U2, target_actor_id: U1 },
		control: { workspace_id: WS, id: U2 },
	},
	{
		covers: ['create_session target_actor_id'],
		tool: 'create_session',
		old: { workspace_id: WS, target_actor_id: U1, action_prompt: 'Go' },
		canonical: { workspace_id: WS, actor_id: U1, action_prompt: 'Go' },
		control: { workspace_id: WS, action_prompt: 'Go' },
	},
	{
		covers: ['list_sessions target_actor_id'],
		tool: 'list_sessions',
		old: { workspace_id: WS, target_actor_id: U1 },
		canonical: { workspace_id: WS, actor_id: U1 },
		control: { workspace_id: WS },
	},
	{
		covers: ['get_objects id'],
		tool: 'get_objects',
		old: { workspace_id: WS, id: U3 },
		canonical: { workspace_id: WS, ids: [U3] },
		control: { workspace_id: WS },
	},
	{
		covers: ['get_workspace_skill id'],
		tool: 'get_workspace_skill',
		old: { workspace_id: WS, id: 'my-skill' },
		canonical: { workspace_id: WS, name: 'my-skill' },
		control: { workspace_id: WS },
	},
	{
		covers: ['update_workspace_skill id'],
		tool: 'update_workspace_skill',
		old: { workspace_id: WS, id: 'my-skill', content: '# Skill' },
		canonical: { workspace_id: WS, name: 'my-skill', content: '# Skill' },
		control: { workspace_id: WS, content: '# Skill' },
	},
	{
		covers: ['delete_workspace_skill id'],
		tool: 'delete_workspace_skill',
		old: { workspace_id: WS, id: 'my-skill' },
		canonical: { workspace_id: WS, name: 'my-skill' },
		control: { workspace_id: WS },
	},
]
