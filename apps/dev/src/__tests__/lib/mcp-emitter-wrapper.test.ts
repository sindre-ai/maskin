import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ALLOWLISTS,
	buildPosthogPayload,
	capture,
	classifyError,
	createInterceptor,
	createLineSplitter,
	isTrackable,
	parseArgs,
} from '../../../../../docker/agent-base/mcp-emitter-wrapper.mjs'

describe('mcp-emitter-wrapper: allowlist', () => {
	it('locks Google Calendar to exactly the six bet-approved tool_names', () => {
		expect(Array.from(ALLOWLISTS['google-calendar']).sort()).toEqual(
			[
				'create_event',
				'get_free_busy',
				'list_calendar_events',
				'list_calendars',
				'send_rsvp',
				'update_event',
			].sort(),
		)
	})

	it('accepts an allowlisted tool_name', () => {
		expect(isTrackable('google-calendar', 'list_calendars')).toBe(true)
	})

	it('drops a tool_name outside the allowlist', () => {
		expect(isTrackable('google-calendar', 'delete_all_events')).toBe(false)
	})

	it('drops any tool for an unknown provider', () => {
		expect(isTrackable('unknown-provider', 'list_calendars')).toBe(false)
	})
})

describe('mcp-emitter-wrapper: classifyError', () => {
	it('resolves an HTTP 401 message to auth_revoked', () => {
		expect(classifyError({ code: -32001, message: 'HTTP 401 Unauthorized' })).toBe('auth_revoked')
	})

	it('resolves an invalid_grant response to auth_revoked', () => {
		expect(
			classifyError({
				code: -32001,
				message: 'Google returned invalid_grant',
				data: { status: 401 },
			}),
		).toBe('auth_revoked')
	})

	it('resolves a plain "unauthorized" message to auth_revoked', () => {
		expect(classifyError({ message: 'unauthorized' })).toBe('auth_revoked')
	})

	it('falls back to a short code-derived string for non-auth errors', () => {
		expect(classifyError({ code: -32603, message: 'Internal error' })).toBe('mcp_-32603')
	})

	it('falls back to the first word of the message when no code is set', () => {
		expect(classifyError({ message: 'RateLimited: too many requests' })).toBe('ratelimited')
	})

	it('returns "unknown" for a null / empty error', () => {
		expect(classifyError(null)).toBe('unknown')
		expect(classifyError({})).toBe('unknown')
	})
})

describe('mcp-emitter-wrapper: createInterceptor', () => {
	it('emits exactly one capture with the right shape on a success response', () => {
		const emitted: unknown[] = []
		const int = createInterceptor({
			toolProvider: 'google-calendar',
			emit: (p) => emitted.push(p),
		})
		int.onClientMessage({
			jsonrpc: '2.0',
			id: 42,
			method: 'tools/call',
			params: { name: 'list_calendars', arguments: {} },
		})
		int.onServerMessage({
			jsonrpc: '2.0',
			id: 42,
			result: { content: [{ type: 'text', text: 'ok' }] },
		})

		expect(emitted).toEqual([
			{
				toolProvider: 'google-calendar',
				toolName: 'list_calendars',
				outcome: 'success',
				errorCode: null,
			},
		])
	})

	it('drops a response for a non-allowlisted tool_name — never captures', () => {
		const emitted: unknown[] = []
		const int = createInterceptor({
			toolProvider: 'google-calendar',
			emit: (p) => emitted.push(p),
		})
		int.onClientMessage({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'delete_all_events', arguments: {} },
		})
		int.onServerMessage({ jsonrpc: '2.0', id: 1, result: {} })

		expect(emitted).toEqual([])
	})

	it('maps a JSON-RPC 401 error response to outcome=error / error_code=auth_revoked', () => {
		const emitted: unknown[] = []
		const int = createInterceptor({
			toolProvider: 'google-calendar',
			emit: (p) => emitted.push(p),
		})
		int.onClientMessage({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'list_calendar_events', arguments: {} },
		})
		int.onServerMessage({
			jsonrpc: '2.0',
			id: 7,
			error: { code: -32001, message: 'HTTP 401 Unauthorized' },
		})

		expect(emitted).toEqual([
			{
				toolProvider: 'google-calendar',
				toolName: 'list_calendar_events',
				outcome: 'error',
				errorCode: 'auth_revoked',
			},
		])
	})

	it('maps a tool-level isError=true result to outcome=error and inspects content for auth_revoked', () => {
		const emitted: unknown[] = []
		const int = createInterceptor({
			toolProvider: 'google-calendar',
			emit: (p) => emitted.push(p),
		})
		int.onClientMessage({
			jsonrpc: '2.0',
			id: 11,
			method: 'tools/call',
			params: { name: 'create_event', arguments: {} },
		})
		int.onServerMessage({
			jsonrpc: '2.0',
			id: 11,
			result: {
				isError: true,
				content: [{ type: 'text', text: 'invalid_grant: token was revoked' }],
			},
		})

		expect(emitted).toEqual([
			{
				toolProvider: 'google-calendar',
				toolName: 'create_event',
				outcome: 'error',
				errorCode: 'auth_revoked',
			},
		])
	})

	it('ignores non-tools/call requests and unmatched responses', () => {
		const emitted: unknown[] = []
		const int = createInterceptor({
			toolProvider: 'google-calendar',
			emit: (p) => emitted.push(p),
		})
		int.onClientMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
		int.onServerMessage({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } })
		// Response with no matching pending request.
		int.onServerMessage({ jsonrpc: '2.0', id: 999, result: {} })

		expect(emitted).toEqual([])
	})

	it('emits one capture per request even when both are inside a JSON-RPC batch', () => {
		const emitted: unknown[] = []
		const int = createInterceptor({
			toolProvider: 'google-calendar',
			emit: (p) => emitted.push(p),
		})
		int.onClientMessage([
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'list_calendars', arguments: {} },
			},
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'get_free_busy', arguments: {} },
			},
		])
		int.onServerMessage([
			{ jsonrpc: '2.0', id: 1, result: {} },
			{ jsonrpc: '2.0', id: 2, result: {} },
		])

		expect(emitted.map((e: { toolName: string }) => e.toolName)).toEqual([
			'list_calendars',
			'get_free_busy',
		])
	})
})

describe('mcp-emitter-wrapper: buildPosthogPayload', () => {
	it('carries the four bet-required properties + $process_person_profile:false', () => {
		const payload = buildPosthogPayload({
			apiKey: 'phc_test',
			toolProvider: 'google-calendar',
			toolName: 'list_calendars',
			outcome: 'success',
			errorCode: null,
			workspaceId: 'ws-abc',
			timestamp: '2026-07-02T12:00:00.000Z',
		})

		expect(payload.event).toBe('mcp_tool_invocation')
		expect(payload.api_key).toBe('phc_test')
		expect(payload.distinct_id).toBe('ws-abc')
		expect(payload.properties).toEqual({
			tool_provider: 'google-calendar',
			tool_name: 'list_calendars',
			outcome: 'success',
			error_code: null,
			workspace_id: 'ws-abc',
			$process_person_profile: false,
		})
	})

	it('emits null workspace_id when the container env is unset', () => {
		const payload = buildPosthogPayload({
			apiKey: 'phc_test',
			toolProvider: 'google-calendar',
			toolName: 'list_calendars',
			outcome: 'success',
			errorCode: null,
			workspaceId: '',
		})
		expect(payload.properties.workspace_id).toBeNull()
		expect(payload.distinct_id).toBe('unknown')
	})
})

describe('mcp-emitter-wrapper: capture', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('POSTs to /i/v0/e/ with the mcp_tool_invocation body when POSTHOG_API_KEY is set', async () => {
		await capture({
			toolProvider: 'google-calendar',
			toolName: 'list_calendars',
			outcome: 'success',
			errorCode: null,
			env: {
				POSTHOG_API_KEY: 'phc_test',
				POSTHOG_HOST: 'https://custom.posthog.test/',
				MASKIN_WORKSPACE_ID: 'ws-1',
			},
		})
		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://custom.posthog.test/i/v0/e/')
		expect(init.method).toBe('POST')
		const body = JSON.parse(init.body as string)
		expect(body.event).toBe('mcp_tool_invocation')
		expect(body.properties.tool_provider).toBe('google-calendar')
		expect(body.properties.tool_name).toBe('list_calendars')
		expect(body.properties.outcome).toBe('success')
		expect(body.properties.workspace_id).toBe('ws-1')
	})

	it('does nothing when POSTHOG_API_KEY is unset — fail-open for local dev', async () => {
		await capture({
			toolProvider: 'google-calendar',
			toolName: 'list_calendars',
			outcome: 'success',
			errorCode: null,
			env: {},
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('swallows fetch failures so a tool call is never affected by telemetry', async () => {
		fetchMock.mockRejectedValueOnce(new Error('network down'))
		await expect(
			capture({
				toolProvider: 'google-calendar',
				toolName: 'list_calendars',
				outcome: 'success',
				errorCode: null,
				env: { POSTHOG_API_KEY: 'phc_test' },
			}),
		).resolves.toBeUndefined()
	})
})

describe('mcp-emitter-wrapper: parseArgs', () => {
	it('accepts a known provider with a valid https upstream URL', () => {
		const { toolProvider, upstreamUrl, extra } = parseArgs([
			'node',
			'/mcp-emitter-wrapper.mjs',
			'google-calendar',
			'https://calendarmcp.googleapis.com/mcp/v1',
			'--transport',
			'sse',
		])
		expect(toolProvider).toBe('google-calendar')
		expect(upstreamUrl).toBe('https://calendarmcp.googleapis.com/mcp/v1')
		expect(extra).toEqual(['--transport', 'sse'])
	})

	it('rejects an unknown provider name', () => {
		expect(() => parseArgs(['node', 'w.mjs', 'not-a-provider', 'https://x.example/mcp'])).toThrow(
			/unknown tool_provider/,
		)
	})

	it('rejects a non-http upstream URL', () => {
		expect(() => parseArgs(['node', 'w.mjs', 'google-calendar', 'file:///etc/passwd'])).toThrow(
			/invalid upstream_url/,
		)
	})
})

describe('mcp-emitter-wrapper: createLineSplitter', () => {
	it('splits on newlines and preserves partial trailing data', () => {
		const seen: string[] = []
		const s = createLineSplitter((line: string) => seen.push(line))
		s.write('one\ntwo\nth')
		expect(seen).toEqual(['one', 'two'])
		s.write('ree\n')
		expect(seen).toEqual(['one', 'two', 'three'])
	})

	it('flush emits any buffered final line without a newline', () => {
		const seen: string[] = []
		const s = createLineSplitter((line: string) => seen.push(line))
		s.write('trailing')
		s.flush()
		expect(seen).toEqual(['trailing'])
	})
})
