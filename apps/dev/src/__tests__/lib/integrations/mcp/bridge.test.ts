import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, mockListTools, mockCallTool, mockClose, MockStdioClientTransport } =
	vi.hoisted(() => ({
		mockConnect: vi.fn(),
		mockListTools: vi.fn(),
		mockCallTool: vi.fn(),
		mockClose: vi.fn(),
		MockStdioClientTransport: vi.fn(),
	}))

// Mock MCP SDK Client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: mockConnect,
		listTools: mockListTools,
		callTool: mockCallTool,
		close: mockClose,
	})),
}))

// Mock StdioClientTransport
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
	StdioClientTransport: MockStdioClientTransport,
}))

// Mock logger
vi.mock('../../../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpSession } from '../../../../lib/integrations/mcp/bridge'

describe('createMcpSession', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [] })
	})

	it('creates transport with command, args, and merged env', async () => {
		await createMcpSession('node', ['server.js'], { MY_VAR: 'val' })

		expect(MockStdioClientTransport).toHaveBeenCalledWith({
			command: 'node',
			args: ['server.js'],
			env: expect.objectContaining({ MY_VAR: 'val' }),
		})
	})

	it('creates Client with correct name and version', async () => {
		await createMcpSession('node', [], {})

		expect(Client).toHaveBeenCalledWith(
			{ name: 'ai-native-agent', version: '1.0.0' },
			{ capabilities: {} },
		)
	})

	it('connects client with transport', async () => {
		await createMcpSession('node', [], {})

		expect(mockConnect).toHaveBeenCalledTimes(1)
		// The transport passed to connect should be the instance created by MockStdioClientTransport
		expect(mockConnect.mock.calls[0][0]).toBeDefined()
	})

	it('maps MCP tools to LLMTool format', async () => {
		mockListTools.mockResolvedValue({
			tools: [
				{
					name: 'read_file',
					description: 'Reads a file',
					inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
				},
			],
		})

		const session = await createMcpSession('node', [], {})

		expect(session.tools).toHaveLength(1)
		expect(session.tools[0].name).toBe('read_file')
		expect(session.tools[0].description).toBe('Reads a file')
		expect(session.tools[0].parameters).toEqual({
			type: 'object',
			properties: { path: { type: 'string' } },
		})
	})

	it('uses empty string when description is missing', async () => {
		mockListTools.mockResolvedValue({
			tools: [{ name: 'no_desc' }],
		})

		const session = await createMcpSession('node', [], {})

		expect(session.tools[0].description).toBe('')
	})

	it('uses default parameters when inputSchema is missing', async () => {
		mockListTools.mockResolvedValue({
			tools: [{ name: 'no_schema', description: 'test' }],
		})

		const session = await createMcpSession('node', [], {})

		expect(session.tools[0].parameters).toEqual({ type: 'object', properties: {} })
	})
})

describe('McpBridgeSession.executeTool', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [] })
	})

	it('calls callTool with name and arguments', async () => {
		mockCallTool.mockResolvedValue({ content: [] })

		const session = await createMcpSession('node', [], {})
		await session.executeTool('my_tool', { key: 'value' })

		expect(mockCallTool).toHaveBeenCalledWith({ name: 'my_tool', arguments: { key: 'value' } })
	})

	it('extracts and joins text content blocks', async () => {
		mockCallTool.mockResolvedValue({
			content: [
				{ type: 'text', text: 'line 1' },
				{ type: 'text', text: 'line 2' },
			],
		})

		const session = await createMcpSession('node', [], {})
		const result = await session.executeTool('tool', {})

		expect(result).toBe('line 1\nline 2')
	})

	it('ignores non-text content blocks', async () => {
		mockCallTool.mockResolvedValue({
			content: [
				{ type: 'text', text: 'hello' },
				{ type: 'image', data: 'base64...' },
				{ type: 'text', text: 'world' },
			],
		})

		const session = await createMcpSession('node', [], {})
		const result = await session.executeTool('tool', {})

		expect(result).toBe('hello\nworld')
	})
})

describe('McpBridgeSession.close', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [] })
	})

	it('calls client.close', async () => {
		mockClose.mockResolvedValue(undefined)

		const session = await createMcpSession('node', [], {})
		await session.close()

		expect(mockClose).toHaveBeenCalledTimes(1)
	})

	it('swallows errors from client.close', async () => {
		mockClose.mockRejectedValue(new Error('close failed'))

		const session = await createMcpSession('node', [], {})
		// Should not throw
		await expect(session.close()).resolves.toBeUndefined()
	})
})
