import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { SEARCH_DATA_USE_RULE } from '@maskin/shared'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

const RUN_ID = '33333333-3333-4333-8333-333333333333'

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function errorResponse(status: number, message: string): Response {
	return {
		ok: false,
		status,
		text: () => Promise.resolve(JSON.stringify({ error: { code: 'ERR', message } })),
	} as Response
}

const finishedRun = (over: Record<string, unknown> = {}) => ({
	id: RUN_ID,
	status: 'done',
	report_md: '## TL;DR\nFive years [1].\n\n## Method\n- Effort: simple',
	usage: { cost_cents: 7 },
	cap: { cap_cents: 100 },
	...over,
})

describe('deep_research', () => {
	const handlers: Record<string, Handler> = {}
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv('SESSION_ID', '')
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers[name] = h as Handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
		createMcpServer(config)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	const calls = () =>
		fetchMock.mock.calls.map(([url, init]) => ({
			method: (init as RequestInit).method,
			path: String(url).replace(config.apiBaseUrl, ''),
			headers: (init as RequestInit).headers as Record<string, string>,
			body: (init as RequestInit).body ? JSON.parse(String((init as RequestInit).body)) : undefined,
		}))

	it('carries the search data-use rule word for word in the tool description', () => {
		expect(tools.deep_research.description).toContain(SEARCH_DATA_USE_RULE)
		expect(SEARCH_DATA_USE_RULE).toContain('For a client-specific question, do not use this tool.')
	})

	it('starts a run with an Idempotency-Key and returns the report when it is ready', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ id: RUN_ID, status: 'queued' }))
			.mockResolvedValueOnce(jsonResponse(finishedRun()))

		const result = await handlers.deep_research({
			question: 'How long must bookkeeping be kept?',
			effort: 'simple',
		})

		const [start, read] = calls()
		expect(start).toMatchObject({
			method: 'POST',
			path: '/api/research',
			body: { question: 'How long must bookkeeping be kept?', effort: 'simple' },
		})
		expect(start?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
		expect(read?.path).toBe(`/api/research/${RUN_ID}`)
		expect(result.isError).toBeUndefined()
		expect(result.content[0]?.text).toContain('Five years [1]')
		expect(result.content[0]?.text).toContain(`research_id: ${RUN_ID}. Status: done.`)
	})

	it('gives the id and status running when the run is not done after 90 seconds', async () => {
		vi.useFakeTimers()
		fetchMock.mockImplementation(async (_url, init) =>
			(init as RequestInit).method === 'POST'
				? jsonResponse({ id: RUN_ID, status: 'queued' })
				: jsonResponse(finishedRun({ status: 'running', report_md: null })),
		)

		const pending = handlers.deep_research({ question: 'q', effort: 'simple' })
		await vi.advanceTimersByTimeAsync(95_000)
		const result = await pending

		expect(result.isError).toBeUndefined()
		expect(result.content[0]?.text).toContain('still running')
		expect(result.content[0]?.text).toContain(RUN_ID)
		// One run was started, however long the wait.
		expect(calls().filter((c) => c.method === 'POST')).toHaveLength(1)
	})

	it('looks up an earlier run with research_id and starts nothing', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(finishedRun({ status: 'capped' })))

		const result = await handlers.deep_research({ research_id: RUN_ID })

		expect(calls().map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/research/${RUN_ID}`])
		expect(result.content[0]?.text).toContain('Status: capped')
	})

	it('reports a failed run as an error', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				finishedRun({ status: 'failed', report_md: null, error: 'The model call failed' }),
			),
		)
		const result = await handlers.deep_research({ research_id: RUN_ID })
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('The model call failed')
	})

	it('gives a validation error for an unknown effort and calls nothing', async () => {
		expect(
			tools.deep_research.inputSchema.safeParse({ question: 'q', effort: 'huge' }).success,
		).toBe(false)

		const result = await handlers.deep_research({ question: 'q', effort: 'huge' })

		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('effort must be one of')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('asks for an effort or a research_id when neither is given', async () => {
		const noEffort = await handlers.deep_research({ question: 'q' })
		expect(noEffort.isError).toBe(true)
		expect(noEffort.content[0]?.text).toContain('Pass an effort')
		const nothing = await handlers.deep_research({})
		expect(nothing.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('answers not enabled when the flag is off for the caller', async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(403, 'Deep research is not enabled for you yet.'))
		const result = await handlers.deep_research({ question: 'q', effort: 'simple' })
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toBe('Deep research is not enabled for you yet.')
		// Only the start was tried.
		expect(calls()).toHaveLength(1)
	})

	it('passes on the plain error for a workspace with only a Claude subscription', async () => {
		fetchMock.mockResolvedValueOnce(
			errorResponse(
				400,
				'Deep research needs an Anthropic API key or a custom model endpoint saved on this workspace.',
			),
		)
		const result = await handlers.deep_research({ question: 'q', effort: 'simple' })
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('needs an Anthropic API key')
	})

	it('says so when a research_id is not found', async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(404, 'Research run not found'))
		const result = await handlers.deep_research({ research_id: RUN_ID })
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('No research run with that research_id')
	})

	it('inside an agent session, a replayed call carries the same Idempotency-Key', async () => {
		vi.stubEnv('SESSION_ID', '44444444-4444-4444-8444-444444444444')
		fetchMock.mockImplementation(async (_url, init) =>
			(init as RequestInit).method === 'POST'
				? jsonResponse({ id: RUN_ID, status: 'queued' })
				: jsonResponse(finishedRun()),
		)
		await handlers.deep_research({ question: 'q', effort: 'simple' })
		await handlers.deep_research({ question: 'q', effort: 'simple' })
		const keys = calls()
			.filter((c) => c.method === 'POST')
			.map((c) => c.headers['Idempotency-Key'])
		expect(keys).toHaveLength(2)
		expect(keys[0]).toMatch(/^mcp:44444444-/)
		expect(keys[0]).toBe(keys[1])
	})
})
