import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AliasHarness, DEFAULT_WORKSPACE_ID, startAliasHarness } from './helpers/alias-harness'

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

// Through a real McpServer and client: a missing required field fails in the SDK's argument
// check before any handler runs, so the text under test is what the agent's client receives.
// 12 to 19 Nov 2026: about 3,360 calls a week failed on one missing required field.

const U1 = '11111111-1111-4111-8111-111111111111'

// The SDK embeds the Zod issues as JSON inside the error text; read the messages as a client does.
function issueMessages(text: string): string {
	const issues = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as Array<{
		message: string
	}>
	return issues.map((i) => i.message).join('\n')
}

describe('missing required fields', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({
			respond: ({ path }) => {
				if (path.startsWith('/api/for-you')) return { items: [] }
				if (path.startsWith('/api/graph')) return { nodes: [], edges: [] }
				return undefined
			},
		})
	})
	afterAll(async () => {
		await harness.close()
	})

	it('create_objects without workspace_id runs in the session workspace', async () => {
		const out = await harness.call('create_objects', {
			nodes: [{ $id: 'n1', type: 'task', status: 'todo', title: 'Hello' }],
		})
		expect(out.isError).toBe(false)
		expect(out.requests).toHaveLength(1)
		expect(out.requests[0]?.path).toBe('/api/graph')
		expect(out.requests[0]?.workspace).toBe(DEFAULT_WORKSPACE_ID)
	})

	it("list_for_you without actor_id asks for the caller's own list", async () => {
		const out = await harness.call('list_for_you', {})
		expect(out.isError).toBe(false)
		expect(out.requests).toHaveLength(1)
		expect(out.requests[0]?.path).toMatch(/^\/api\/for-you\??$/)
	})

	it('list_for_you with actor_id still asks for that person', async () => {
		const out = await harness.call('list_for_you', { actor_id: U1 })
		expect(out.requests[0]?.path).toBe(`/api/for-you?for_actor_id=${U1}`)
	})

	it.each([
		['update_notification', { status: 'seen' }, 'Missing required key "id": the notification id'],
		['get_file', {}, 'Missing required key "id": the file id'],
		['get_objects', {}, 'Missing required key "ids"'],
		['create_trigger', { name: 't' }, 'Missing required key "action_prompt"'],
		['create_trigger', { action_prompt: 'p' }, 'Missing required key "name"'],
	])('%s names the missing field', async (tool, args, expected) => {
		const out = await harness.call(tool as string, args as Record<string, unknown>)
		expect(out.isError).toBe(true)
		expect(issueMessages(out.text)).toContain(expected)
		expect(out.requests).toHaveLength(0)
	})

	it('create_trigger without a target says how to give one', async () => {
		const out = await harness.call('create_trigger', {
			name: 't',
			type: 'cron',
			config: { expression: '0 * * * *' },
			action_prompt: 'p',
		})
		expect(out.isError).toBe(true)
		expect(out.text).toContain('Missing required key "target_actor_id"')
		expect(out.text).toContain('list_actors')
		expect(out.requests).toHaveLength(0)
	})

	it('get_objects and get_file name the missing key beside a misspelt one', async () => {
		const objects = await harness.call('get_objects', { object_id: U1 })
		expect(objects.isError).toBe(true)
		const objectsText = issueMessages(objects.text)
		expect(objectsText).toContain('Unrecognised argument name: object_id (use ids: ["<uuid>"])')
		expect(objectsText).toContain('Missing required key: ids.')
		const file = await harness.call('get_file', { file_id: U1 })
		expect(file.text).toContain('file_id (use id)')
		expect(file.text).toContain('Missing required key: id.')
	})

	it('does not add a missing-key note when the required key was sent', async () => {
		const out = await harness.call('get_objects', { ids: [U1], include_content: true })
		expect(out.text).toContain('Unrecognised argument name: include_content')
		expect(out.text).not.toContain('Missing required key')
	})

	it('get_objects lists the allowed include values', async () => {
		const listed = (await harness.listTools()).find((t) => t.name === 'get_objects')
		expect(JSON.stringify(listed?.inputSchema)).toContain(
			'Allowed values: content, metadata, relationships, connected_objects, events, files',
		)
	})
})
