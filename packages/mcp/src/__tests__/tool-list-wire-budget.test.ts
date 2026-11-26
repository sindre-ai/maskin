import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createMcpServer } from '../server'

// The tool list as a client receives it: a real server and client over a linked in-memory pair,
// the tools array from tools/list serialised and counted in bytes. Measured 22 Nov 2026:
// 217,879 bytes for 123 tools (300,751 on main before the bet). The Lighter Maskin tool replies
// bet wins under 220 KB; this budget keeps 1 KB of room under 219 KB. Raise it on purpose, with
// the new size in the PR, never to make a red test green.
const WIRE_TOOL_LIST_BUDGET = 219_000

describe('tool list on the wire', () => {
	it('stays under its byte budget', async () => {
		const server = createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: '00000000-0000-0000-0000-0000000000aa',
			telemetrySink: () => {},
		})
		const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
		const client = new Client({ name: 'tool-list-wire-budget', version: '1' })
		await Promise.all([server.connect(serverSide), client.connect(clientSide)])
		try {
			const { tools } = await client.listTools()
			const bytes = Buffer.byteLength(JSON.stringify(tools))
			expect(tools.length).toBeGreaterThan(100)
			expect(
				bytes,
				`tool list is ${bytes} bytes on the wire, budget ${WIRE_TOOL_LIST_BUDGET}`,
			).toBeLessThan(WIRE_TOOL_LIST_BUDGET)
		} finally {
			await client.close()
			await server.close()
		}
	})
})
