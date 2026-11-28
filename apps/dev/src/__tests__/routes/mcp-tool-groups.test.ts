import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Covers resolveToolGroups in routes/mcp.ts: the only code that runs when
// MASKIN_TOOL_GROUPS is on. The MCP SDK is stubbed so the test reads what the
// route hands to createMcpServer.
const { mockHandleRequest, MockTransport, mockCreateMcpServer, isToolGroupsEnabled, readGranted } =
	vi.hoisted(() => {
		const mockConnect = vi.fn().mockResolvedValue(undefined)
		const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
		const MockTransport = vi.fn().mockImplementation(() => ({ handleRequest: mockHandleRequest }))
		const mockCreateMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
		const isToolGroupsEnabled = vi.fn()
		const readGranted = vi.fn()
		return {
			mockHandleRequest,
			MockTransport,
			mockCreateMcpServer,
			isToolGroupsEnabled,
			readGranted,
		}
	})

vi.mock('@maskin/mcp', () => ({
	createMcpServer: mockCreateMcpServer,
	READ_TOOL_NAMES: new Set<string>(),
	isToolGroupsEnabled,
	readGrantedToolGroups: readGranted,
}))
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

const validateApiKey = vi.fn()
vi.mock('@maskin/auth', () => ({
	validateApiKey,
	generateApiKey: vi.fn(),
	hashPassword: vi.fn(),
	verifyPassword: vi.fn(),
	authMiddleware: vi.fn(),
}))

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const STORED_TOOLS = { maskin_tool_groups: ['computer'] }

function makeDb(rows: Array<{ tools: unknown }>) {
	return { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) }
}

type TestEnv = { Variables: { db: unknown } }

async function createApp(db: unknown) {
	const app = new Hono<TestEnv>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	const mod = await import('../../routes/mcp')
	app.route('/mcp', mod.default)
	mod.__resetMcpActorCache()
	mod.__resetMcpTraceSeq()
	return app
}

async function post(app: Hono<TestEnv>, body: unknown) {
	const outgoing = {
		writeHead: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		headersSent: false,
		setHeader: vi.fn(),
	}
	await app.request(
		new Request('http://localhost/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer ank_test',
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify(body),
		}),
		undefined,
		{ incoming: { url: '/mcp', method: 'POST' }, outgoing },
	)
}

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
const toolsCall = {
	jsonrpc: '2.0',
	id: 2,
	method: 'tools/call',
	params: { name: 'get_objects', arguments: {} },
}

function configPassedToServer(): { toolGroups?: string[] } {
	return mockCreateMcpServer.mock.calls[0][0]
}

describe('MCP tool groups via /mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockHandleRequest.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
		isToolGroupsEnabled.mockReturnValue(true)
		readGranted.mockReturnValue(['computer'])
	})

	it('passes the agent granted groups to createMcpServer on tools/list', async () => {
		const app = await createApp(makeDb([{ tools: STORED_TOOLS }]))
		await post(app, toolsList)

		expect(readGranted).toHaveBeenCalledWith(STORED_TOOLS)
		expect(configPassedToServer().toolGroups).toEqual(['computer'])
	})

	it('lists everything when the setting is off', async () => {
		isToolGroupsEnabled.mockReturnValue(false)
		const app = await createApp(makeDb([{ tools: STORED_TOOLS }]))
		await post(app, toolsList)

		expect(readGranted).not.toHaveBeenCalled()
		expect(configPassedToServer().toolGroups).toBeUndefined()
	})

	it('does not narrow a tools/call', async () => {
		const app = await createApp(makeDb([{ tools: STORED_TOOLS }]))
		await post(app, toolsCall)

		expect(configPassedToServer().toolGroups).toBeUndefined()
	})

	it('lists everything when the lookup fails', async () => {
		const failing = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => {
							throw new Error('db down')
						},
					}),
				}),
			}),
		}
		const app = await createApp(failing)
		await post(app, toolsList)

		expect(configPassedToServer().toolGroups).toBeUndefined()
	})
})
