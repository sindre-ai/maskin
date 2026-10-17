// The legacy (2025-era) requests whose exact answers are recorded from v1 main.
//
// Only requests whose answer does not depend on which workspace the test uses
// belong here, because the fixtures compare status, content type and body
// exactly. The workspace-dependent ones (tools/list, tools/call ok, resources)
// are covered by rows that assert shape and by the tool digest fixture.

export interface LegacyCase {
	id: string
	describes: string
	method: 'POST' | 'GET' | 'DELETE'
	/** Object or array is sent as JSON, a string is sent verbatim. */
	body?: unknown
	noAuth?: boolean
}

export const LEGACY_CASES: readonly LegacyCase[] = [
	{
		id: 'initialize',
		describes: 'Legacy handshake',
		method: 'POST',
		body: {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'maskin-conformance', version: '1' },
			},
		},
	},
	{
		id: 'initialized-notification',
		describes: 'A notification is acknowledged with an empty 202',
		method: 'POST',
		body: { jsonrpc: '2.0', method: 'notifications/initialized' },
	},
	{
		id: 'ping',
		describes: 'Ping answers an empty result',
		method: 'POST',
		body: { jsonrpc: '2.0', id: 2, method: 'ping' },
	},
	{
		id: 'tools-call-unknown-tool',
		describes: 'Calling a tool that does not exist',
		method: 'POST',
		body: {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'no_such_tool', arguments: {} },
		},
	},
	{
		id: 'tools-call-bad-arguments',
		describes: 'Calling a tool with an argument of the wrong type',
		method: 'POST',
		body: {
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'get_objects', arguments: { ids: 'not-an-array' } },
		},
	},
	{
		id: 'tools-call-no-authorization',
		describes: 'A tool call with no Authorization header (current behaviour, pinned)',
		method: 'POST',
		noAuth: true,
		body: {
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: { name: 'get_workspace_schema', arguments: {} },
		},
	},
	{
		id: 'batch-array',
		describes: 'A JSON-RPC batch array is answered with an array, in order',
		method: 'POST',
		body: [
			{ jsonrpc: '2.0', id: 6, method: 'ping' },
			{ jsonrpc: '2.0', id: 7, method: 'ping' },
		],
	},
	{ id: 'get-405', describes: 'GET is refused', method: 'GET' },
	{ id: 'delete-405', describes: 'DELETE is refused', method: 'DELETE' },
	{
		id: 'malformed-json',
		describes: 'A body that is not JSON',
		method: 'POST',
		body: '{not json',
	},
]

export interface RecordedResponse {
	status: number
	/** Lower-cased content-type exactly as the server sent it. */
	contentType: string | null
	/** Parsed JSON when the body is JSON, otherwise the raw text. */
	body: unknown
}

export interface LegacyFixtureFile {
	recordedFrom: string
	recordedAt: string
	cases: Array<{ id: string; response: RecordedResponse }>
}

export interface ToolsDigestFixture {
	recordedFrom: string
	recordedAt: string
	/** Tool names and per-tool digests in listed order. */
	tools: Array<{ name: string; digest: string }>
}
