import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	READ_TOOL_NAMES,
	buildReadErrorBody,
	classifyReadError,
	parseApiErrorStatus,
	pickNext,
	reasonFromError,
	toolErrorResponse,
} from '../read-error'

describe('parseApiErrorStatus', () => {
	it('extracts the HTTP status from an apiFetch-style error message', () => {
		expect(parseApiErrorStatus(new Error('API error 404: Not found'))).toBe(404)
		expect(parseApiErrorStatus(new Error('API error 500: boom'))).toBe(500)
	})

	it('returns null when the message does not carry an API status prefix', () => {
		expect(parseApiErrorStatus(new Error('Not authenticated'))).toBeNull()
		expect(parseApiErrorStatus('bare string error')).toBeNull()
		expect(parseApiErrorStatus(undefined)).toBeNull()
	})
})

describe('classifyReadError', () => {
	it('classifies HTTP status codes into read-error kinds', () => {
		expect(classifyReadError(new Error('API error 404: gone'))).toBe('not_found')
		expect(classifyReadError(new Error('API error 400: bad'))).toBe('invalid_param')
		expect(classifyReadError(new Error('API error 422: unprocessable'))).toBe('invalid_param')
		expect(classifyReadError(new Error('API error 401: nope'))).toBe('permission')
		expect(classifyReadError(new Error('API error 403: nope'))).toBe('permission')
		expect(classifyReadError(new Error('API error 429: slow down'))).toBe('rate_limit')
		expect(classifyReadError(new Error('API error 500: boom'))).toBe('server')
		expect(classifyReadError(new Error('API error 502: boom'))).toBe('server')
	})

	it('classifies local pre-flight guards without hitting the API status prefix', () => {
		expect(classifyReadError(new Error('No workspace specified. Set X-Workspace-Id.'))).toBe(
			'invalid_param',
		)
		expect(classifyReadError(new Error('Not authenticated. Add Authorization header.'))).toBe(
			'permission',
		)
		expect(classifyReadError(new Error('Loop abc not found in this workspace.'))).toBe('not_found')
	})

	it('falls back to unknown when nothing matches', () => {
		expect(classifyReadError(new Error('something weird happened'))).toBe('unknown')
	})
})

describe('reasonFromError', () => {
	it('strips the API error prefix and labels the reason by kind', () => {
		const err = new Error('API error 404: Object not found')
		expect(reasonFromError(err, 'not_found')).toBe('Not found: Object not found')
	})

	it('preserves the message when no prefix is present', () => {
		const err = new Error('No workspace specified')
		expect(reasonFromError(err, 'invalid_param')).toBe('Invalid argument: No workspace specified')
	})

	it('labels unknown kinds instead of returning them verbatim', () => {
		// Prefixing distinguishes a genuinely unclassified failure from a plain
		// not-found message when a human or agent later reads the reason string.
		expect(reasonFromError(new Error('mystery'), 'unknown')).toBe('Unexpected error: mystery')
	})
})

describe('pickNext', () => {
	it('returns a search-oriented next tool for not_found on get_objects', () => {
		const next = pickNext('get_objects', 'not_found')
		expect(next.tool).toBe('search_objects')
		expect(next.hint.toLowerCase()).toContain('search_objects')
	})

	it('returns the same tool with a corrective example for invalid_param', () => {
		const next = pickNext('list_objects', 'invalid_param')
		expect(next.tool).toBe('list_objects')
		expect(next.hint).toContain('list_objects')
	})

	it('routes permission failures to list_workspaces by default', () => {
		const next = pickNext('get_file', 'permission')
		expect(next.tool).toBe('list_workspaces')
	})

	it('provides a retry hint for rate limits and server errors', () => {
		const rl = pickNext('list_objects', 'rate_limit')
		expect(rl.tool).toBe('list_objects')
		expect(rl.hint.toLowerCase()).toMatch(/rate.?limit|back.?off|retry/i)

		const srv = pickNext('list_objects', 'server')
		expect(srv.tool).toBe('list_objects')
		expect(srv.hint.toLowerCase()).toMatch(/retry|transient|server/i)
	})

	it('falls back to a generic workspace hint for unregistered tools', () => {
		const next = pickNext('some_new_tool', 'not_found')
		expect(next.tool).toBe('list_workspaces')
		expect(next.hint).toBeTruthy()
	})

	it('does not reuse not_found guidance for unknown-kind errors', () => {
		// unknown is as likely to be a real bug as a missing resource — routing
		// it into the same "search again" guidance as not_found would mask the
		// failure instead of surfacing it (see server.ts's console.error for the
		// other half of this fix: unknown errors are also now logged).
		const notFound = pickNext('get_objects', 'not_found')
		const unknown = pickNext('get_objects', 'unknown')
		expect(unknown).not.toEqual(notFound)
		expect(unknown.tool).toBe('get_objects')
		expect(unknown.hint.toLowerCase()).toMatch(/unexpected|bug|report/)
	})
})

describe('buildReadErrorBody', () => {
	it('produces { error: { tool, reason, next } } with all three fields present', () => {
		const body = buildReadErrorBody('get_objects', new Error('API error 404: not there'))
		expect(body.error.tool).toBe('get_objects')
		expect(body.error.reason).toMatch(/not found/i)
		expect(body.error.next.tool).toBeTruthy()
		expect(body.error.next.hint).toBeTruthy()
	})

	it('carries the api-response detail through the reason field', () => {
		const body = buildReadErrorBody(
			'list_objects',
			new Error('API error 400: Validation failed. Fields: name: Required'),
		)
		expect(body.error.reason).toContain('Validation failed')
		expect(body.error.reason).toContain('name: Required')
	})
})

describe('toolErrorResponse', () => {
	it('emits compact JSON in the text channel and mirrors it in structuredContent', () => {
		const resp = toolErrorResponse('get_objects', new Error('API error 404: Object missing'))
		expect(resp.isError).toBe(true)
		expect(resp._meta.toolName).toBe('get_objects')
		// Compact JSON — no newlines/indentation (T1 lean-response contract).
		expect(resp.content[0].text).not.toContain('\n')
		expect(resp.content[0].text).not.toMatch(/ {3,}/)
		const parsedText = JSON.parse(resp.content[0].text)
		expect(parsedText).toEqual(resp.structuredContent)
		expect(parsedText.error.next.tool).toBe('search_objects')
	})

	it('preserves the failing tool name on both channels', () => {
		const resp = toolErrorResponse('list_files', new Error('API error 403: Forbidden'))
		expect(resp.structuredContent.error.tool).toBe('list_files')
		expect(JSON.parse(resp.content[0].text).error.tool).toBe('list_files')
	})
})

describe('READ_TOOL_NAMES', () => {
	it('covers every read-side tool (list_*, search_*, get_*) that has GUIDANCE', () => {
		// The wrapper in server.ts uses this set to decide whether to convert a
		// thrown error into a structured response. Both the set and the GUIDANCE
		// table need to stay in sync — an entry in one without the other means a
		// tool either silently keeps the throw or gets a fallback hint.
		for (const name of READ_TOOL_NAMES) {
			// If a tool is in the set, pickNext must produce a real (non-fallback)
			// entry for its notFound kind.
			const next = pickNext(name, 'not_found')
			expect(next.tool, `${name} needs GUIDANCE`).toBeTruthy()
			expect(next.hint, `${name} needs a hint`).toBeTruthy()
		}
	})

	it('includes the three tools the T2 DoD explicitly names', () => {
		expect(READ_TOOL_NAMES.has('get_objects')).toBe(true)
		expect(READ_TOOL_NAMES.has('search_objects')).toBe(true)
		// At least one list_* tool
		expect(READ_TOOL_NAMES.has('list_objects')).toBe(true)
	})
})

// End-to-end: drive the real registered handlers via createMcpServer against
// stubbed API failures and assert each of the three DoD error classes lands as
// a structured `{ error: { tool, reason, next } }` response.
describe('read-side handler error envelopes (T2 DoD)', () => {
	const wsId = '00000000-0000-0000-0000-0000000000aa'
	const config = {
		apiBaseUrl: 'http://localhost:3000',
		apiKey: 'ank_testkey',
		defaultWorkspaceId: wsId,
		telemetrySink: () => {},
	}

	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(async () => {
		vi.resetModules()
		handlers = new Map()

		vi.doMock('@modelcontextprotocol/ext-apps/server', () => ({
			registerAppTool: vi.fn((_s: unknown, name: string, _def: unknown, handler: unknown) => {
				handlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>)
			}),
			registerAppResource: vi.fn(),
			RESOURCE_MIME_TYPE: 'text/html',
		}))
		vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
			McpServer: vi.fn().mockImplementation(() => ({
				registerResource: vi.fn(),
				connect: vi.fn(),
			})),
			ResourceTemplate: vi.fn().mockImplementation(() => ({})),
		}))
		vi.doMock('node:fs', () => ({ readFileSync: vi.fn().mockReturnValue('<html>mock</html>') }))

		const { createMcpServer } = await import('../server')
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.doUnmock('@modelcontextprotocol/ext-apps/server')
		vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js')
		vi.doUnmock('node:fs')
	})

	async function runWith404(toolName: string, args: Record<string, unknown>) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve('not found'),
			headers: new Headers(),
		} as Response)
		const handler = handlers.get(toolName)
		if (!handler) throw new Error(`Handler ${toolName} not registered`)
		return handler(args)
	}

	async function runWith400(toolName: string, args: Record<string, unknown>) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status: 400,
			text: () => Promise.resolve('{"error":{"message":"Bad input"}}'),
			headers: new Headers(),
		} as Response)
		const handler = handlers.get(toolName)
		if (!handler) throw new Error(`Handler ${toolName} not registered`)
		return handler(args)
	}

	async function runWith403(toolName: string, args: Record<string, unknown>) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve('{"error":{"message":"Forbidden"}}'),
			headers: new Headers(),
		} as Response)
		const handler = handlers.get(toolName)
		if (!handler) throw new Error(`Handler ${toolName} not registered`)
		return handler(args)
	}

	type Envelope = {
		isError?: boolean
		structuredContent?: {
			error?: { tool: string; reason: string; next: { tool: string; hint: string } }
		}
	}

	it('get_objects → not_found → structured error naming search_objects as next', async () => {
		// get_objects catches per-id errors inline and stores them under
		// results[i].error rather than throwing, so the envelope shape it uses
		// is the same `{ tool, reason, next }` but embedded per-id.
		const result = (await runWith404('get_objects', {
			ids: ['00000000-0000-0000-0000-0000000000bb'],
		})) as { content: Array<{ text: string }> }
		const parsed = JSON.parse(result.content[0].text) as Array<{
			id: string
			success: boolean
			error?: { tool: string; reason: string; next: { tool: string; hint: string } }
		}>
		expect(parsed).toHaveLength(1)
		expect(parsed[0].success).toBe(false)
		expect(parsed[0].error?.tool).toBe('get_objects')
		expect(parsed[0].error?.reason).toMatch(/not found/i)
		expect(parsed[0].error?.next.tool).toBe('search_objects')
		expect(parsed[0].error?.next.hint).toBeTruthy()
	})

	it('get_objects → invalid_param → structured error naming get_objects as next', async () => {
		const result = (await runWith400('get_objects', {
			ids: ['00000000-0000-0000-0000-0000000000bb'],
		})) as { content: Array<{ text: string }> }
		const parsed = JSON.parse(result.content[0].text) as Array<{
			id: string
			success: boolean
			error?: { tool: string; reason: string; next: { tool: string; hint: string } }
		}>
		expect(parsed[0].error?.tool).toBe('get_objects')
		expect(parsed[0].error?.reason).toMatch(/invalid argument/i)
		expect(parsed[0].error?.next.tool).toBe('get_objects')
	})

	it('get_objects → permission → structured error naming list_workspaces as next', async () => {
		const result = (await runWith403('get_objects', {
			ids: ['00000000-0000-0000-0000-0000000000bb'],
		})) as { content: Array<{ text: string }> }
		const parsed = JSON.parse(result.content[0].text) as Array<{
			id: string
			success: boolean
			error?: { tool: string; reason: string; next: { tool: string; hint: string } }
		}>
		expect(parsed[0].error?.tool).toBe('get_objects')
		expect(parsed[0].error?.reason).toMatch(/permission denied/i)
		expect(parsed[0].error?.next.tool).toBe('list_workspaces')
	})

	it('search_objects → not_found → returns structured error envelope', async () => {
		const result = (await runWith404('search_objects', { q: 'anything' })) as Envelope
		expect(result.isError).toBe(true)
		const err = result.structuredContent?.error
		expect(err?.tool).toBe('search_objects')
		expect(err?.reason).toMatch(/not found/i)
		expect(err?.next.tool).toBe('list_objects')
		expect(err?.next.hint).toBeTruthy()
	})

	it('search_objects → invalid_param → same tool with corrective example', async () => {
		const result = (await runWith400('search_objects', { q: '' })) as Envelope
		const err = result.structuredContent?.error
		expect(err?.tool).toBe('search_objects')
		expect(err?.reason).toMatch(/invalid argument/i)
		expect(err?.next.tool).toBe('search_objects')
	})

	it('search_objects → permission → next.tool is list_workspaces', async () => {
		const result = (await runWith403('search_objects', { q: 'x' })) as Envelope
		const err = result.structuredContent?.error
		expect(err?.reason).toMatch(/permission denied/i)
		expect(err?.next.tool).toBe('list_workspaces')
	})

	it('list_objects → not_found → structured error envelope with non-empty fields', async () => {
		const result = (await runWith404('list_objects', {})) as Envelope
		expect(result.isError).toBe(true)
		const err = result.structuredContent?.error
		expect(err?.tool).toBe('list_objects')
		expect(err?.reason.length).toBeGreaterThan(0)
		expect(err?.next.tool.length).toBeGreaterThan(0)
		expect(err?.next.hint.length).toBeGreaterThan(0)
	})

	it('list_objects → invalid_param → same tool with corrective example', async () => {
		const result = (await runWith400('list_objects', {})) as Envelope
		const err = result.structuredContent?.error
		expect(err?.tool).toBe('list_objects')
		expect(err?.next.tool).toBe('list_objects')
	})

	it('list_objects → permission → next.tool is list_workspaces', async () => {
		const result = (await runWith403('list_objects', {})) as Envelope
		const err = result.structuredContent?.error
		expect(err?.reason).toMatch(/permission denied/i)
		expect(err?.next.tool).toBe('list_workspaces')
	})
})

describe('provider_terminal — codes that must never be retried', () => {
	function errWithCode(status: number, code: string): Error {
		const err = new Error(`API error ${status}: upstream said no`)
		;(err as Error & { apiErrorCode?: string }).apiErrorCode = code
		return err
	}

	// Regression: apiFetch dropped the backend's `error.code`, and 423/424 match
	// no status branch, so both of these classified as 'unknown' — whose guidance
	// says "Retry once." For a restricted LinkedIn account that is the one action
	// the error taxonomy explicitly forbids, because retrying deepens the
	// upstream restriction.
	it('classifies a restricted account as provider_terminal, not unknown', () => {
		expect(classifyReadError(errWithCode(423, 'LINKEDIN_ACCOUNT_RESTRICTED'))).toBe(
			'provider_terminal',
		)
	})

	it('classifies a missing credential as provider_terminal', () => {
		expect(classifyReadError(errWithCode(424, 'CREDENTIAL_NOT_CONNECTED'))).toBe(
			'provider_terminal',
		)
	})

	it('classifies a revoked credential as provider_terminal', () => {
		expect(classifyReadError(errWithCode(401, 'CREDENTIAL_REVOKED'))).toBe('provider_terminal')
	})

	it('falls back to the status when no code is attached', () => {
		expect(classifyReadError(new Error('API error 423: restricted'))).toBe('provider_terminal')
		expect(classifyReadError(new Error('API error 424: not connected'))).toBe('provider_terminal')
	})

	it('never advises a retry for a provider_terminal error', () => {
		for (const tool of ['create_object', 'update_object', 'unknown_tool']) {
			const next = pickNext(tool, 'provider_terminal')
			expect(next.hint).toMatch(/do not retry/i)
			expect(next.hint).not.toMatch(/retry (the same call|once)/i)
		}
	})

	// LinkedIn's tools moved to the provider's own MCP server, but its six-class
	// codes still arrive here as upstream errors carrying an HTTP status, so the
	// classification must keep handling them.
	it('builds a full envelope for a restricted account', () => {
		const body = buildReadErrorBody(
			'create_object',
			errWithCode(423, 'LINKEDIN_ACCOUNT_RESTRICTED'),
		)
		expect(body.error.tool).toBe('create_object')
		expect(body.error.reason).toMatch(/connection unavailable/i)
		expect(body.error.next.hint).toMatch(/do not retry/i)
	})
})
