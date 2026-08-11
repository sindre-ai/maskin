import { describe, expect, it } from 'vitest'
// The emitter script lives under docker/agent-base/ because it runs in the
// agent container. Its pure functions are exported for exactly this test path.
import {
	ALLOWLIST_BY_PROVIDER,
	buildEventBody,
	buildRemoteArgs,
	classifyResponse,
	extractToolCallRequest,
	parseJsonRpcLine,
} from '../../../../../docker/agent-base/mcp-tool-invocation-emitter.mjs'

describe('mcp-tool-invocation-emitter — allowlist', () => {
	it('exposes the six locked google-calendar tool names and only those', () => {
		const gc = ALLOWLIST_BY_PROVIDER['google-calendar']
		expect(gc).toBeInstanceOf(Set)
		expect([...gc].sort()).toEqual([
			'create_event',
			'get_free_busy',
			'list_calendar_events',
			'list_calendars',
			'send_rsvp',
			'update_event',
		])
	})

	it('has no allowlist for unknown providers so the wrapper refuses to launch them', () => {
		expect(ALLOWLIST_BY_PROVIDER.gmail).toBeUndefined()
		expect(ALLOWLIST_BY_PROVIDER.linear).toBeUndefined()
	})
})

describe('mcp-tool-invocation-emitter — parseJsonRpcLine', () => {
	it('parses a well-formed JSON-RPC line', () => {
		const msg = parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
		expect(msg).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
	})

	it('returns null on non-JSON diagnostic lines (mcp-remote logs)', () => {
		expect(parseJsonRpcLine('[mcp-remote] connected to https://calendarmcp...')).toBeNull()
		expect(parseJsonRpcLine('')).toBeNull()
		expect(parseJsonRpcLine('   ')).toBeNull()
	})

	it('returns null on malformed JSON so the passthrough never crashes', () => {
		expect(parseJsonRpcLine('{"jsonrpc":"2.0",broken')).toBeNull()
	})

	it('returns null on JSON that is not JSON-RPC 2.0', () => {
		expect(parseJsonRpcLine('{"foo":"bar"}')).toBeNull()
	})
})

describe('mcp-tool-invocation-emitter — extractToolCallRequest', () => {
	it('returns the id and tool_name for tools/call', () => {
		const req = extractToolCallRequest({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'list_calendars', arguments: {} },
		})
		expect(req).toEqual({ id: 7, toolName: 'list_calendars' })
	})

	it('returns null for tools/list, initialize, and notifications', () => {
		expect(extractToolCallRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeNull()
		expect(extractToolCallRequest({ jsonrpc: '2.0', id: 2, method: 'initialize' })).toBeNull()
		// notification: no id
		expect(
			extractToolCallRequest({
				jsonrpc: '2.0',
				method: 'notifications/message',
				params: {},
			}),
		).toBeNull()
	})

	it('returns null when tools/call params.name is missing so we never emit without a tool_name', () => {
		expect(
			extractToolCallRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} }),
		).toBeNull()
	})
})

describe('mcp-tool-invocation-emitter — classifyResponse', () => {
	it('classifies a plain result as success with null error_code', () => {
		expect(classifyResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toEqual({
			outcome: 'success',
			errorCode: null,
		})
	})

	it('classifies a JSON-RPC error carrying an invalid_grant string as auth_revoked', () => {
		expect(
			classifyResponse({
				jsonrpc: '2.0',
				id: 2,
				error: { code: -32000, message: 'Google returned invalid_grant on refresh' },
			}),
		).toEqual({ outcome: 'error', errorCode: 'auth_revoked' })
	})

	it('classifies a JSON-RPC error with code 401 as auth_revoked', () => {
		expect(
			classifyResponse({ jsonrpc: '2.0', id: 3, error: { code: 401, message: 'Unauthorized' } }),
		).toEqual({ outcome: 'error', errorCode: 'auth_revoked' })
	})

	it('classifies an MCP tool-level error (result.isError) as error', () => {
		expect(
			classifyResponse({
				jsonrpc: '2.0',
				id: 4,
				result: {
					isError: true,
					content: [{ type: 'text', text: 'Google 401: token has been expired or revoked' }],
				},
			}),
		).toEqual({ outcome: 'error', errorCode: 'auth_revoked' })
	})

	it('classifies a rate-limit error as rate_limited', () => {
		expect(
			classifyResponse({
				jsonrpc: '2.0',
				id: 5,
				error: { code: 429, message: 'rate limit exceeded' },
			}),
		).toEqual({ outcome: 'error', errorCode: 'rate_limited' })
	})

	it('classifies an unknown error as tool_error (extensible reason taxonomy)', () => {
		expect(
			classifyResponse({
				jsonrpc: '2.0',
				id: 6,
				error: { code: -32603, message: 'Internal error' },
			}),
		).toEqual({ outcome: 'error', errorCode: 'tool_error' })
	})
})

describe('mcp-tool-invocation-emitter — buildEventBody', () => {
	const allowlist = ALLOWLIST_BY_PROVIDER['google-calendar']

	it('produces a capture with the exact ship-metric shape on success', () => {
		const now = new Date('2026-07-02T18:30:00.000Z')
		const body = buildEventBody({
			apiKey: 'phc_test',
			toolProvider: 'google-calendar',
			toolName: 'list_calendars',
			workspaceId: 'ws-1',
			classification: { outcome: 'success', errorCode: null },
			allowlist,
			now,
		})
		expect(body).toEqual({
			api_key: 'phc_test',
			event: 'mcp_tool_invocation',
			distinct_id: 'ws-1',
			properties: {
				tool_provider: 'google-calendar',
				tool_name: 'list_calendars',
				outcome: 'success',
				error_code: null,
				workspace_id: 'ws-1',
				$process_person_profile: false,
			},
			timestamp: '2026-07-02T18:30:00.000Z',
		})
	})

	it('produces a capture with outcome=error and error_code=auth_revoked on revoked grant', () => {
		const body = buildEventBody({
			apiKey: 'phc_test',
			toolProvider: 'google-calendar',
			toolName: 'create_event',
			workspaceId: 'ws-1',
			classification: { outcome: 'error', errorCode: 'auth_revoked' },
			allowlist,
			now: new Date('2026-07-02T18:30:00.000Z'),
		})
		expect(body?.properties.outcome).toBe('error')
		expect(body?.properties.error_code).toBe('auth_revoked')
	})

	it('returns null for a tool_name outside the allowlist so unrelated MCP tools never emit', () => {
		const body = buildEventBody({
			apiKey: 'phc_test',
			toolProvider: 'google-calendar',
			toolName: 'delete_calendar', // not in the six-tool allowlist
			workspaceId: 'ws-1',
			classification: { outcome: 'success', errorCode: null },
			allowlist,
			now: new Date(),
		})
		expect(body).toBeNull()
	})

	it('falls back distinct_id to provider: prefix when workspace_id is missing', () => {
		const body = buildEventBody({
			apiKey: 'phc_test',
			toolProvider: 'google-calendar',
			toolName: 'list_calendars',
			workspaceId: '',
			classification: { outcome: 'success', errorCode: null },
			allowlist,
			now: new Date('2026-07-02T18:30:00.000Z'),
		})
		expect(body?.distinct_id).toBe('provider:google-calendar')
		expect(body?.properties.workspace_id).toBeNull()
	})
})

describe('mcp-tool-invocation-emitter — buildRemoteArgs', () => {
	it('appends the Authorization header exactly once when MASKIN_MCP_AUTH_HEADER is set', () => {
		const args = buildRemoteArgs({
			url: 'https://calendarmcp.googleapis.com/mcp/v1',
			authHeader: 'Bearer ya29.a0test',
		})
		expect(args).toEqual([
			'-y',
			'mcp-remote',
			'https://calendarmcp.googleapis.com/mcp/v1',
			'--header',
			'Authorization:Bearer ya29.a0test',
		])
	})

	it('omits the --header flag entirely when no auth header is provided', () => {
		const args = buildRemoteArgs({
			url: 'https://calendarmcp.googleapis.com/mcp/v1',
			authHeader: '',
		})
		expect(args).toEqual(['-y', 'mcp-remote', 'https://calendarmcp.googleapis.com/mcp/v1'])
	})

	it('throws when the URL is missing so the wrapper cannot silently degrade', () => {
		expect(() => buildRemoteArgs({ url: undefined, authHeader: 'Bearer x' })).toThrow(
			/missing MCP endpoint URL/,
		)
	})
})
