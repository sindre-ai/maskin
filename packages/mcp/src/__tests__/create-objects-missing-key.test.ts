import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../server'
import { CREATE_OBJECTS_EXAMPLE_CALL, tools } from '../tools'

// Drives the real MCP server through an in-memory client, so the text under
// test is the one the SDK builds from the Zod issues, not one written by hand.
// Validation fails before any handler runs, so no API is reached.
const WS_ID = '00000000-0000-0000-0000-0000000000aa'

async function callCreateObjects(args: Record<string, unknown>) {
	const server = createMcpServer({
		apiBaseUrl: 'http://localhost:0',
		apiKey: 'ank_test',
		defaultWorkspaceId: WS_ID,
		telemetrySink: () => {},
	})
	const client = new Client({ name: 'create-objects-test', version: '0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(b), client.connect(a)])
	try {
		const res = (await client.callTool({ name: 'create_objects', arguments: args })) as {
			isError?: boolean
			content?: Array<{ text?: string }>
		}
		return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' }
	} catch (err) {
		return { isError: true, text: err instanceof Error ? err.message : String(err) }
	}
}

// The SDK embeds the Zod issues as JSON inside the error text, so quotes in a
// message come back escaped. Read the messages the way an agent's client does.
function issueMessages(text: string): string {
	const issues = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as Array<{
		message: string
	}>
	return issues.map((i) => i.message).join('\n')
}

const validNode = { $id: 'n1', type: 'task', status: 'todo', title: 'Hello' }

describe('create_objects missing-key errors', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('names workspace_id and nodes, and shows a correct call, when both are missing', async () => {
		const { isError, text: raw } = await callCreateObjects({})
		const text = isError ? issueMessages(raw) : raw
		expect(isError).toBe(true)
		expect(text).toContain('Missing required key "workspace_id"')
		expect(text).toContain('Missing required key "nodes"')
		expect(text).toContain(CREATE_OBJECTS_EXAMPLE_CALL)
	})

	it('names each key a node is missing', async () => {
		const { isError, text: raw } = await callCreateObjects({ workspace_id: WS_ID, nodes: [{}] })
		const text = issueMessages(raw)
		expect(isError).toBe(true)
		expect(text).toContain('Missing required key "$id"')
		expect(text).toContain('Missing required key "type"')
		expect(text).toContain('Missing required key "status"')
		expect(text).toContain(CREATE_OBJECTS_EXAMPLE_CALL)
	})

	it('names only the key that is missing', async () => {
		const { text: raw } = await callCreateObjects({
			workspace_id: WS_ID,
			nodes: [{ $id: 'n1', type: 'task', title: 'Hello' }],
		})
		const text = issueMessages(raw)
		expect(text).toContain('Missing required key "status"')
		expect(text).not.toContain('Missing required key "type"')
		expect(text).not.toContain('Missing required key "$id"')
		expect(text).not.toContain('Missing required key "workspace_id"')
	})

	it('does not echo a value the caller sent', async () => {
		const secret = 'SECRET-TITLE-d41d8cd9'
		const { text: raw } = await callCreateObjects({
			workspace_id: WS_ID,
			nodes: [{ $id: 'n1', type: 'task', title: secret }],
		})
		expect(issueMessages(raw)).toContain('Missing required key "status"')
		expect(raw).not.toContain(secret)
	})

	it('the example call is itself accepted by the schema', () => {
		const example = JSON.parse(CREATE_OBJECTS_EXAMPLE_CALL.replace('<workspace uuid>', WS_ID))
		expect(tools.create_objects.inputSchema.safeParse(example).success).toBe(true)
	})

	it('still rejects what it rejected before', async () => {
		for (const args of [
			{ workspace_id: 'not-a-uuid', nodes: [validNode] },
			{ workspace_id: WS_ID, nodes: [] },
			{ workspace_id: WS_ID, nodes: 'task' },
			{ workspace_id: WS_ID, nodes: [{ ...validNode, status: 3 }] },
			{ workspace_id: WS_ID, nodes: [{ ...validNode, driver: 'not-a-uuid' }] },
		]) {
			const { isError } = await callCreateObjects(args)
			expect(isError, JSON.stringify(args)).toBe(true)
		}
	})

	it('still accepts a valid call and reaches the API', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			headers: new Headers(),
			json: () => Promise.resolve({ nodes: [{ id: 'o1', type: 'task', $id: 'n1' }], edges: [] }),
		} as Response)
		const { isError, text } = await callCreateObjects({ workspace_id: WS_ID, nodes: [validNode] })
		expect(isError).toBe(false)
		expect(text).not.toContain('Missing required key')
		expect(fetchSpy).toHaveBeenCalled()
	})
})
