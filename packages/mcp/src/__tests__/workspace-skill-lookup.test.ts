import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../server'

// Drives the real McpServer through an in-memory client, with fetch stubbed to
// stand in for the skill routes. Covers skill lookup by id or name: the key
// stays `name`, only its value may now be an id.

const wsId = '00000000-0000-4000-8000-0000000000aa'
const skillId = '11111111-1111-4111-8111-111111111111'
const SKILL_TOOLS = ['get_workspace_skill', 'update_workspace_skill', 'delete_workspace_skill']

const notFoundText = (ref: string) =>
	`No skill with id or name '${ref}' in this workspace. Call list_workspace_skills for valid ids and names.`

const skillRow = {
	id: skillId,
	workspaceId: wsId,
	name: 'deploy-prod',
	description: 'Ship to prod',
	content: '---\nname: deploy-prod\n---\n\nRun the deploy.',
}

async function connect() {
	const server = createMcpServer({
		apiBaseUrl: 'http://localhost:3000',
		apiKey: 'ank_testkey',
		defaultWorkspaceId: wsId,
		telemetrySink: () => {},
	})
	const client = new Client({ name: 'test', version: '0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(b), client.connect(a)])
	return client
}

function stubSkillApi(known: Record<string, typeof skillRow>) {
	const requested: string[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const path = new URL(String(input)).pathname
		requested.push(path)
		const ref = decodeURIComponent(path.split('/skills/')[1] ?? '')
		const row = known[ref]
		if (!row) {
			return new Response(
				JSON.stringify({ error: { code: 'NOT_FOUND', message: notFoundText(ref) } }),
				{ status: 404, headers: { 'Content-Type': 'application/json' } },
			)
		}
		return new Response(JSON.stringify(row), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		})
	})
	return requested
}

function textOf(result: { content?: unknown }): string {
	const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>
	return blocks.map((b) => b.text ?? '').join('')
}

describe('skill lookup by id or name through the MCP server', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('get_workspace_skill with the skill id in name returns the skill', async () => {
		const requested = stubSkillApi({ [skillId]: skillRow, 'deploy-prod': skillRow })
		const client = await connect()

		const byId = await client.callTool({
			name: 'get_workspace_skill',
			arguments: { name: skillId },
		})
		const byName = await client.callTool({
			name: 'get_workspace_skill',
			arguments: { name: 'deploy-prod' },
		})

		expect(requested).toEqual([
			`/api/workspaces/${wsId}/skills/${skillId}`,
			`/api/workspaces/${wsId}/skills/deploy-prod`,
		])
		expect(JSON.parse(textOf(byId))).toEqual(skillRow)
		expect(JSON.parse(textOf(byName))).toEqual(skillRow)
	})

	it('tools/list keeps the name argument and only describes it as id or name', async () => {
		const client = await connect()
		const { tools } = await client.listTools()

		for (const toolName of SKILL_TOOLS) {
			const tool = tools.find((t) => t.name === toolName)
			const schema = tool?.inputSchema as {
				required?: string[]
				properties: Record<string, Record<string, unknown>>
			}
			expect(schema.required).toContain('name')
			expect(schema.properties.name).toMatchObject({
				type: 'string',
				minLength: 1,
				maxLength: 64,
				pattern: '^[a-z0-9-]+$',
				description: 'Skill id (from list_workspace_skills) or name.',
			})
			expect(tool?.description).toMatch(/by id or name/)
		}
		expect(tools.find((t) => t.name === 'skill_id')).toBeUndefined()
	})

	it('get_workspace_skill pins the not-found text in the read-error envelope', async () => {
		stubSkillApi({})
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const client = await connect()

		const result = await client.callTool({
			name: 'get_workspace_skill',
			arguments: { name: skillId },
		})

		expect(result.isError).toBe(true)
		const body = JSON.parse(textOf(result))
		expect(body.error.tool).toBe('get_workspace_skill')
		expect(body.error.reason).toBe(`Not found: ${notFoundText(skillId)}`)
		expect(body.error.next.tool).toBe('list_workspace_skills')
		expect(body.error.next.hint).toContain('skill ids and names')
		errorSpy.mockRestore()
	})

	it.each(['update_workspace_skill', 'delete_workspace_skill'])(
		'%s pins the raw not-found text from the API',
		async (toolName) => {
			stubSkillApi({})
			const client = await connect()
			const args =
				toolName === 'update_workspace_skill'
					? { name: skillId, content: 'new body' }
					: { name: skillId }

			const result = await client
				.callTool({ name: toolName, arguments: args })
				.catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }))

			expect(result.isError).toBe(true)
			expect(textOf(result)).toContain(`API error 404: ${notFoundText(skillId)}`)
		},
	)
})
