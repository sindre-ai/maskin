import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same wiring as server.test.ts: spin up the real createMcpServer with the SDK
// mocked, then drive the registered handlers. Schema validation does not run
// inside a handler, so each test first runs the tool's own zod schema over the
// raw arguments, the way the SDK does before it calls the handler.
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

const WS_ID = '00000000-0000-0000-0000-0000000000aa'
const OBJ_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_ID = '22222222-2222-2222-2222-222222222222'
const FILE_ID = '33333333-3333-3333-3333-333333333333'

type ToolResult = { content: Array<{ text: string }> }
type ParseOutcome =
	| { success: true; data: unknown }
	| { success: false; error: { message: string } }

describe('batch write tools reject bad input instead of returning an empty success', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let inputSchemas: Map<string, { safeParse: (raw: unknown) => ParseOutcome }>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		inputSchemas = new Map()
		vi.mocked(registerAppTool).mockImplementation((_server, name, def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
			inputSchemas.set(name as string, (def as { inputSchema: never }).inputSchema)
		})
		createMcpServer(config)

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const u = String(url)
			let body: unknown = []
			if (u.endsWith('/api/workspaces')) body = [{ id: 'ws-default-123', settings: {} }]
			else if (u.includes('/api/objects/')) body = { id: OBJ_ID, type: 'bet' }
			return { ok: true, headers: new Headers(), json: () => Promise.resolve(body) } as Response
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	/** Runs the schema the way the SDK does, then hands the parsed args to the handler. */
	function callUpdateObjects(rawArgs: Record<string, unknown>) {
		const parsed = tools.update_objects.inputSchema.parse(rawArgs)
		return getHandler('update_objects')(parsed as Record<string, unknown>)
	}

	/**
	 * Runs the schema the server registered with the SDK (the one that wraps the
	 * alias and unknown-name checks), then the handler, the way the SDK does. A
	 * failed parse is reported as an error result, as the SDK reports it.
	 */
	async function callRegisteredUpdateObjects(rawArgs: Record<string, unknown>) {
		const schema = inputSchemas.get('update_objects')
		if (!schema) throw new Error('update_objects not registered')
		const parsed = schema.safeParse(rawArgs)
		if (!parsed.success) return { isError: true, text: parsed.error.message }
		await getHandler('update_objects')(parsed.data as Record<string, unknown>)
		return { isError: false, text: '' }
	}

	function apiCalls() {
		return vi.mocked(fetch).mock.calls
	}

	function methodOf(call: unknown[]) {
		return (call[1] as RequestInit | undefined)?.method ?? 'GET'
	}

	/** Every API call that is not a plain read. */
	function writeCalls() {
		return apiCalls().filter((c) => methodOf(c) !== 'GET')
	}

	function writeCallsWith(method: string) {
		return apiCalls().filter((c) => methodOf(c) === method)
	}

	describe('update_objects', () => {
		it('rejects a list sent as a JSON string at the schema, naming the field', () => {
			const list = JSON.stringify([{ id: OBJ_ID, status: 'done' }])
			const result = tools.update_objects.inputSchema.safeParse({ updates: list })
			expect(result.success).toBe(false)
			if (!result.success) expect(result.error.issues[0]?.path).toEqual(['updates'])
			expect(apiCalls()).toHaveLength(0)
		})

		it('throws when the list has the wrong argument name, and writes nothing', async () => {
			const call = callUpdateObjects({ objects: [{ id: OBJ_ID, status: 'done' }] })
			await expect(call).rejects.toThrow(/Expected updates as an array/)
			await expect(call).rejects.toThrow(/name the list updates \(not objects\)/)
			expect(apiCalls()).toHaveLength(0)
		})

		it('throws on an empty updates list, and writes nothing', async () => {
			await expect(callUpdateObjects({ updates: [] })).rejects.toThrow(/wrote nothing/)
			expect(apiCalls()).toHaveLength(0)
		})

		it('throws when the updates list is missing entirely, and writes nothing', async () => {
			await expect(callUpdateObjects({})).rejects.toThrow(/received no updates and no edges/)
			expect(apiCalls()).toHaveLength(0)
		})

		it('throws for an entry with an id and no field, and writes nothing', async () => {
			const call = callUpdateObjects({ updates: [{ id: OBJ_ID }] })
			await expect(call).rejects.toThrow(new RegExp(`${OBJ_ID}\\) has a field to change`))
			expect(apiCalls()).toHaveLength(0)
		})

		it('throws for an entry whose only field is unrecognised (dropped by the schema)', async () => {
			const call = callUpdateObjects({ updates: [{ id: OBJ_ID, state: 'done' }] })
			await expect(call).rejects.toThrow(/has a field to change/)
			expect(apiCalls()).toHaveLength(0)
		})

		it('throws for an entry whose only fields are empty attach and detach lists', async () => {
			const call = callUpdateObjects({
				updates: [{ id: OBJ_ID, attach_file_ids: [], detach_file_ids: [] }],
			})
			await expect(call).rejects.toThrow(/lists count as nothing/)
			expect(apiCalls()).toHaveLength(0)
		})

		it('reports an idle entry as a failure in a mixed call, writes the valid one', async () => {
			const result = (await callUpdateObjects({
				updates: [{ id: OBJ_ID, status: 'done' }, { id: OTHER_ID }],
			})) as ToolResult

			const { results } = JSON.parse(result.content[0].text) as {
				results: Array<{ id: string; success: boolean; error?: string }>
			}
			const patches = writeCallsWith('PATCH')
			expect(patches).toHaveLength(1)
			expect(String(patches[0]?.[0])).toContain(`/api/objects/${OBJ_ID}`)
			expect(results.find((r) => r.id === OBJ_ID)?.success).toBe(true)
			const idle = results.find((r) => r.id === OTHER_ID)
			expect(idle?.success).toBe(false)
			expect(idle?.error).toMatch(/No field to change/)
		})

		it('still accepts an edges-only call', async () => {
			const result = (await callUpdateObjects({
				edges: [{ source_id: OBJ_ID, target_id: OTHER_ID, type: 'relates_to' }],
			})) as ToolResult

			const { results } = JSON.parse(result.content[0].text) as {
				results: Array<{ type: string; success: boolean }>
			}
			expect(results).toHaveLength(1)
			expect(results[0]).toMatchObject({ type: 'relationship', success: true })
			expect(writeCalls()).toHaveLength(1)
		})

		it('leaves a valid call unchanged: one PATCH and one success entry', async () => {
			const result = (await callUpdateObjects({
				updates: [{ id: OBJ_ID, status: 'done' }],
			})) as ToolResult

			const { results } = JSON.parse(result.content[0].text) as {
				results: Array<{ id: string; success: boolean }>
			}
			expect(results).toEqual([expect.objectContaining({ id: OBJ_ID, success: true })])
			expect(writeCalls()).toHaveLength(1)
		})

		it('treats a non-empty attach list on an id-only entry as a real change', async () => {
			await callUpdateObjects({ updates: [{ id: OBJ_ID, attach_file_ids: [FILE_ID] }] })
			expect(writeCallsWith('PATCH')).toHaveLength(0)
			expect(writeCallsWith('POST')).toHaveLength(1)
		})
	})

	describe('update_objects unrecognised argument names', () => {
		const validUpdates = [{ id: OBJ_ID, status: 'done' }]
		const validEdges = [{ source_id: OBJ_ID, target_id: OTHER_ID, type: 'relates_to' }]

		it('errors on valid edges plus a misnamed updates list, and writes nothing', async () => {
			const out = await callRegisteredUpdateObjects({ edges: validEdges, objects: validUpdates })
			expect(out.isError).toBe(true)
			expect(out.text).toContain('Unrecognised argument name: objects')
			expect(out.text).toContain('Accepted names: workspace_id, updates, edges')
			expect(apiCalls()).toHaveLength(0)
		})

		it('errors on valid updates plus a misnamed edges list, and writes nothing', async () => {
			const out = await callRegisteredUpdateObjects({ updates: validUpdates, links: validEdges })
			expect(out.isError).toBe(true)
			expect(out.text).toContain('Unrecognised argument name: links')
			expect(apiCalls()).toHaveLength(0)
		})

		it('errors on valid edges plus an unknown extra argument, and writes nothing', async () => {
			const out = await callRegisteredUpdateObjects({ edges: validEdges, dry_run: true })
			expect(out.isError).toBe(true)
			expect(out.text).toContain('Unrecognised argument name: dry_run')
			expect(apiCalls()).toHaveLength(0)
		})

		it('names every unrecognised argument when there are several', async () => {
			const out = await callRegisteredUpdateObjects({ edges: validEdges, a: 1, b: 2 })
			expect(out.isError).toBe(true)
			expect(out.text).toContain('Unrecognised argument names: a, b')
			expect(apiCalls()).toHaveLength(0)
		})

		it('still accepts a valid mixed call with the workspace id', async () => {
			const out = await callRegisteredUpdateObjects({
				workspace_id: WS_ID,
				updates: validUpdates,
				edges: validEdges,
			})
			expect(out.isError).toBe(false)
			expect(writeCallsWith('PATCH')).toHaveLength(1)
			expect(writeCalls()).toHaveLength(2)
		})

		it('still accepts an old spelling the alias layer rewrites (updates.driver_id)', async () => {
			const out = await callRegisteredUpdateObjects({
				updates: [{ id: OBJ_ID, driver_id: OTHER_ID }],
			})
			expect(out.isError).toBe(false)
			expect(writeCallsWith('PATCH')).toHaveLength(1)
		})

		it('does not reject unknown names on other tools (no global strict mode)', () => {
			const schema = inputSchemas.get('create_objects')
			if (!schema) throw new Error('create_objects not registered')
			const parsed = schema.safeParse({
				workspace_id: WS_ID,
				nodes: [{ $id: 'a', type: 'bet', status: 'opportunity' }],
				harmless_extra: true,
			})
			expect(parsed.success).toBe(true)
		})
	})

	// create_objects is already safe: nodes is required with min(1) and has no
	// default, so a missing, misnamed, empty or string-typed list fails in the
	// schema. Pinned here so a future default cannot reopen the hole unnoticed.
	describe('create_objects', () => {
		const node = { $id: 'a', type: 'bet' }

		it.each([
			['missing nodes', {}],
			['nodes under the wrong name', { objects: [node] }],
			['an empty nodes list', { nodes: [] }],
			['nodes sent as a JSON string', { nodes: JSON.stringify([node]) }],
		])('rejects %s at the schema and posts nothing', (_label, rawArgs) => {
			const result = tools.create_objects.inputSchema.safeParse({ workspace_id: WS_ID, ...rawArgs })
			expect(result.success).toBe(false)
			if (!result.success) expect(result.error.issues[0]?.path).toEqual(['nodes'])
			expect(apiCalls()).toHaveLength(0)
		})
	})

	// update_extension is the model for the guard above: with nothing to change
	// it throws rather than returning a success.
	describe('update_extension', () => {
		it('throws when nothing is specified, and writes nothing', async () => {
			const call = getHandler('update_extension')({ workspace_id: 'ws-default-123', id: 'work' })
			await expect(call).rejects.toThrow(/No changes specified/)
			expect(writeCalls()).toHaveLength(0)
		})
	})
})
