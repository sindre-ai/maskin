import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../server'
import { createVoiceToolkit } from '../voice-tools'

const config = {
	apiBaseUrl: 'http://localhost:0',
	apiKey: 'test',
	defaultWorkspaceId: '00000000-0000-4000-8000-000000000000',
}

describe('createVoiceToolkit', () => {
	it('exposes exactly the tools an MCP client gets from tools/list', async () => {
		const server = createMcpServer(config)
		const client = new Client({ name: 'chat', version: '0' })
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([server.connect(b), client.connect(a)])
		const chat = await client.listTools()

		const { tools } = await createVoiceToolkit(config)

		expect(tools.map((t) => t.name).sort()).toEqual(chat.tools.map((t) => t.name).sort())
		expect(tools.length).toBeGreaterThan(8)
	})

	it('hands the model the real schemas, including list_objects pagination', async () => {
		const { tools } = await createVoiceToolkit(config)
		const listObjects = tools.find((t) => t.name === 'list_objects')
		expect(listObjects?.type).toBe('function')
		expect(Object.keys((listObjects?.parameters.properties ?? {}) as object)).toEqual(
			expect.arrayContaining(['cursor', 'limit', 'status', 'type']),
		)
	})
})

describe('createVoiceToolkit — agent MCP servers', () => {
	async function startExternalServer() {
		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
		const { StreamableHTTPServerTransport } = await import(
			'@modelcontextprotocol/sdk/server/streamableHttp.js'
		)
		const { createServer } = await import('node:http')
		const { z } = await import('zod')
		const seenAuth: Array<string | undefined> = []
		const http = createServer(async (req, res) => {
			seenAuth.push(req.headers.authorization)
			const mcp = new McpServer({ name: 'fake-gmail', version: '0' })
			mcp.tool('send email', 'Send an email', { to: z.string() }, async ({ to }) => ({
				content: [{ type: 'text', text: `sent to ${to}` }],
			}))
			mcp.tool('read inbox', 'Read the inbox', {}, { readOnlyHint: true }, async () => ({
				content: [{ type: 'text', text: 'empty' }],
			}))
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
			res.on('close', () => transport.close())
			await mcp.connect(transport)
			const chunks: Buffer[] = []
			for await (const c of req) chunks.push(c as Buffer)
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
			await transport.handleRequest(req, res, body)
		})
		await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
		const port = (http.address() as { port: number }).port
		return { url: `http://127.0.0.1:${port}/mcp`, seenAuth, stop: () => http.close() }
	}

	it('lists an agent server’s tools beside the Maskin ones and routes calls to it', async () => {
		const ext = await startExternalServer()
		try {
			const toolkit = await createVoiceToolkit(config, {
				gmail: { url: ext.url, headers: { Authorization: 'Bearer tok' } },
			})
			const names = toolkit.tools.map((t) => t.name)
			expect(names).toContain('list_objects')
			expect(names).toContain('gmail__send_email')
			expect(toolkit.unreachableServers).toEqual([])

			const result = (await toolkit.invokeTool(
				'gmail__send_email',
				{ to: 'a@b.c' },
				{ actorId: 'a', workspaceId: 'w' },
			)) as { content: Array<{ text: string }> }
			expect(result.content[0]?.text).toBe('sent to a@b.c')
			expect(ext.seenAuth).toContain('Bearer tok')
			await toolkit.close()
		} finally {
			ext.stop()
		}
	})

	it('counts a platform read and an agent-server tool that declares readOnlyHint as reads, nothing else', async () => {
		const ext = await startExternalServer()
		try {
			const toolkit = await createVoiceToolkit(config, { gmail: { url: ext.url } })
			expect(toolkit.readOnlyTools.has('list_objects')).toBe(true)
			expect(toolkit.readOnlyTools.has('gmail__read_inbox')).toBe(true)
			expect(toolkit.readOnlyTools.has('gmail__send_email')).toBe(false)
			expect(toolkit.readOnlyTools.has('create_comment')).toBe(false)
			await toolkit.close()
		} finally {
			ext.stop()
		}
	})

	it('keeps the call alive and reports a server it cannot reach', async () => {
		const toolkit = await createVoiceToolkit(config, {
			down: { url: 'http://127.0.0.1:1/mcp' },
		})
		expect(toolkit.unreachableServers).toEqual(['down'])
		expect(toolkit.tools.map((t) => t.name)).toContain('list_objects')
		await toolkit.close()
	})

	it('adds no extra tools when the agent has no servers', async () => {
		const withNone = await createVoiceToolkit(config, {})
		const plain = await createVoiceToolkit(config)
		expect(withNone.tools.map((t) => t.name)).toEqual(plain.tools.map((t) => t.name))
	})

	it('does not follow a redirect to another address', async () => {
		const { createServer } = await import('node:http')
		let targetHits = 0
		const target = createServer((_req, res) => {
			targetHits++
			res.end('{}')
		})
		await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
		const targetPort = (target.address() as { port: number }).port
		const redirector = createServer((_req, res) => {
			res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/mcp` })
			res.end()
		})
		await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r))
		const port = (redirector.address() as { port: number }).port
		try {
			const toolkit = await createVoiceToolkit(config, {
				hop: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer secret' } },
			})
			expect(toolkit.unreachableServers).toEqual(['hop'])
			expect(targetHits).toBe(0)
			await toolkit.close()
		} finally {
			target.close()
			redirector.close()
		}
	})

	it('closes what it opened when setup fails halfway', async () => {
		const close = vi.spyOn(Client.prototype, 'close')
		const listTools = vi
			.spyOn(Client.prototype, 'listTools')
			.mockRejectedValueOnce(new Error('boom'))
		try {
			await expect(createVoiceToolkit(config)).rejects.toThrow('boom')
			expect(close).toHaveBeenCalled()
		} finally {
			listTools.mockRestore()
			close.mockRestore()
		}
	})
})
