import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// See aliases.test.ts: keep the stdio entry point of ../server from listening
// on this process's stdin.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
	StdioServerTransport: class {
		onmessage?: unknown
		onclose?: unknown
		onerror?: unknown
		async start() {}
		async send() {}
		async close() {}
	},
}))

// Through a real McpServer and client, because the unknown-name check runs inside
// the SDK's argument validation. 12 Nov 2026: list_relationships called with
// entity_id (it takes object_id) ignored the name and listed unrelated rows.

const U1 = '11111111-1111-4111-8111-111111111111'

describe('relationship, graph and file reads reject unknown parameter names', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({
			respond: ({ path }) => (path.startsWith('/api/relationships') ? [] : undefined),
		})
	})
	afterAll(async () => {
		await harness.close()
	})

	it('list_relationships: entity_id fails and names object_id, with no API call', async () => {
		const out = await harness.call('list_relationships', { entity_id: U1 })
		expect(out.isError).toBe(true)
		expect(out.text).toContain('Unrecognised argument name: entity_id (use object_id)')
		expect(out.text).toContain('Accepted names: workspace_id, object_id, source_id')
		expect(out.text).not.toContain('Nothing was written')
		expect(out.requests).toHaveLength(0)
	})

	it('list_relationships: no filter fails instead of listing the workspace', async () => {
		const out = await harness.call('list_relationships', { limit: 10 })
		expect(out.isError).toBe(true)
		expect(out.text).toContain('Pass at least one of: object_id, source_id, target_id, type')
		expect(out.requests).toHaveLength(0)
	})

	it.each([{ object_id: U1 }, { source_id: U1, type: 'in_loop' }, { type: 'attached', limit: 5 }])(
		'list_relationships still accepts %j',
		async (args) => {
			const out = await harness.call('list_relationships', args)
			expect(out.isError).toBe(false)
			expect(out.requests).toHaveLength(1)
		},
	)

	it('traverse_graph, get_objects, list_files and get_file name the accepted spelling', async () => {
		const cases: Array<[string, Record<string, unknown>, string]> = [
			['traverse_graph', { start_id: U1 }, 'start_id (use object_id)'],
			['get_objects', { ids: [U1], include_content: true }, 'include_content (use include:'],
			['list_files', { query: 'video' }, 'query (use q)'],
			['get_file', { file_id: U1 }, 'file_id (use id)'],
		]
		for (const [tool, args, expected] of cases) {
			const out = await harness.call(tool, args)
			expect(out.isError, tool).toBe(true)
			expect(out.text, tool).toContain(`Unrecognised argument name: ${expected}`)
			expect(out.requests, tool).toHaveLength(0)
		}
	})

	it('still accepts the documented parameters on those tools', async () => {
		for (const [tool, args] of [
			['traverse_graph', { object_id: U1, max_depth: 2 }],
			['get_objects', { ids: [U1], include: ['content'] }],
			['list_files', { q: 'video', limit: 5 }],
			['get_file', { id: U1 }],
		] as Array<[string, Record<string, unknown>]>) {
			const out = await harness.call(tool, args)
			expect(out.text, tool).not.toContain('Unrecognised argument')
		}
	})

	it('update_objects keeps saying nothing was written', async () => {
		const out = await harness.call('update_objects', { changes: [] })
		expect(out.isError).toBe(true)
		expect(out.text).toContain('Nothing was written.')
	})
})
