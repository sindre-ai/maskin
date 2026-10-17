// THE table. One row is one behaviour of the /mcp endpoint, written once and
// run for every client style it applies to. The docs are generated from this
// file (docs.ts), so a row's "proves" sentence is user-facing text.
//
// Rows are written against the tech spec (sections 3.3 to 3.9) where the code
// they cover has not landed yet. A row that needs a server feature the server
// under test lacks reports "pending", not a failure (see Feature in types.ts).

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, listingDigest, stripSchemaUri, toolDigests } from './canonical'
import type { ToolListing } from './canonical'
import {
	LEGACY_CASES,
	type LegacyFixtureFile,
	type RecordedResponse,
	type ToolsDigestFixture,
} from './legacy-cases'
import { runLegacyCase } from './legacy-replay'
import type { ClientStyle, Row, RowContext, Target } from './types'
import {
	MODERN_VERSION,
	bare,
	legacyInitialize,
	legacyRequest,
	post,
	postModern,
	rpc,
	rpcResult,
} from './wire'

const here = dirname(fileURLToPath(import.meta.url))

function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8')) as T
}

const ALL: readonly ClientStyle[] = [
	'raw-legacy',
	'sdk-legacy',
	'sdk-auto',
	'sdk-modern',
	'raw-modern',
]
const RAW: readonly ClientStyle[] = ['raw-legacy', 'raw-modern']
const MODERN: readonly ClientStyle[] = ['sdk-modern', 'raw-modern']

const UI_MIME = 'text/html;profile=mcp-app'

/** The era a style is expected to end up in, given what the server under test offers. */
function expectedEra(ctx: RowContext): 'legacy' | 'modern' {
	if (ctx.style === 'raw-modern' || ctx.style === 'sdk-modern') return 'modern'
	if (ctx.style === 'sdk-auto') {
		return ctx.env.flag === 'on' && ctx.features.has('modern-leg') ? 'modern' : 'legacy'
	}
	return 'legacy'
}

async function rawTools(target: Target, modern: boolean): Promise<ToolListing[]> {
	const observed = modern
		? await postModern(target, 'tools/list')
		: await post(target, legacyRequest('tools/list'))
	return rpcResult(observed).tools as ToolListing[]
}

function normalise(response: RecordedResponse): RecordedResponse {
	return { ...response, body: JSON.parse(JSON.stringify(response.body)) }
}

export const ROWS: readonly Row[] = [
	// ── Handshake and discovery ───────────────────────────────────────────────
	{
		id: 'handshake',
		area: 'Handshake',
		title: 'Connect and agree a protocol era',
		proves:
			'Legacy clients get the 2025-era handshake, pinned modern clients get 2026-07-28, and a client in auto mode lands in whichever era the server offers.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			const info = await driver.connect()
			const era = expectedEra(ctx)
			assert.equal(info.era, era)
			if (era === 'modern') assert.equal(info.protocolVersion, MODERN_VERSION)
			else assert.match(info.protocolVersion ?? '', /^20\d\d-\d\d-\d\d$/)
			await driver.close()
		},
	},
	{
		id: 'discover',
		area: 'Handshake',
		title: 'server/discover returns the capability manifest',
		proves:
			'A modern client can ask what the server supports and gets 2026-07-28, honest capabilities (no change notifications we never send) and a complete result.',
		styles: ['raw-modern'],
		async run(ctx) {
			const observed = await postModern(ctx.target, 'server/discover')
			assert.equal(observed.status, 200)
			const result = rpcResult(observed)
			assert.ok((result.supportedVersions as string[]).includes(MODERN_VERSION))
			assert.equal(result.resultType, 'complete')
			const capabilities = result.capabilities as Record<
				string,
				{ listChanged?: boolean } | undefined
			>
			for (const area of ['tools', 'resources', 'prompts'] as const) {
				assert.notEqual(
					capabilities[area]?.listChanged,
					true,
					`${area}.listChanged must not be advertised`,
				)
			}
		},
	},
	{
		id: 'modern-refused-when-flag-off',
		area: 'Handshake',
		title: 'Flag off: modern requests are refused, legacy keeps working',
		proves:
			'With MASKIN_MCP_MODERN off, a modern request never gets a modern answer, a pinned modern client cannot connect, auto falls back to legacy, and legacy clients are unaffected.',
		styles: ['raw-modern', 'sdk-modern', 'sdk-auto', 'raw-legacy'],
		flag: 'off',
		async run(ctx) {
			if (ctx.style === 'raw-modern') {
				const observed = await postModern(ctx.target, 'server/discover')
				const body = rpc(observed)
				assert.ok(
					observed.status >= 400 || body.error !== undefined,
					`a modern request must be refused, got ${observed.status} ${observed.text.slice(0, 200)}`,
				)
				assert.equal(body.result?.resultType, undefined, 'no modern result may be served')
				return
			}
			if (ctx.style === 'sdk-modern') {
				const driver = await ctx.driver()
				await assert.rejects(driver.connect())
				return
			}
			const driver = await ctx.driver()
			const info = await driver.connect()
			assert.equal(info.era, 'legacy')
			assert.ok((await driver.listTools()).length > 0)
			await driver.close()
		},
	},

	// ── tools/list ────────────────────────────────────────────────────────────
	{
		id: 'tools-list',
		area: 'Tools',
		title: 'tools/list returns the same tools, in the same order, as v1',
		proves:
			'Every client style sees exactly the tool list recorded from v1 main (names and order), and the raw styles also match every description, annotation and input schema (the schema dialect URI is the one allowed difference).',
		styles: ALL,
		async run(ctx) {
			const recorded = fixture<ToolsDigestFixture>('legacy-v1-tools-digest.json')
			const driver = await ctx.driver()
			await driver.connect()
			const names = (await driver.listTools()).map((t) => t.name)
			assert.deepEqual(
				names,
				recorded.tools.map((t) => t.name),
			)
			if (ctx.style === 'raw-legacy' || ctx.style === 'raw-modern') {
				const live = toolDigests(await rawTools(ctx.target, ctx.style === 'raw-modern'))
				const drifted = live
					.filter((t, i) => t.digest !== recorded.tools[i]?.digest)
					.map((t) => t.name)
				assert.deepEqual(
					drifted,
					[],
					`tools whose definition changed since v1: ${drifted.join(', ')}`,
				)
			}
			await driver.close()
		},
	},
	{
		id: 'tools-list-stable',
		area: 'Tools',
		title: 'tools/list is byte-identical across calls and restarts',
		proves:
			'Calling tools/list twice returns the same bytes, and a later run against a restarted server returns the same digest, so no tool description is built from runtime data.',
		styles: RAW,
		async run(ctx) {
			const modern = ctx.style === 'raw-modern'
			const send = () =>
				modern
					? postModern(ctx.target, 'tools/list')
					: post(ctx.target, legacyRequest('tools/list'))
			const first = JSON.stringify(rpcResult(await send()))
			const second = JSON.stringify(rpcResult(await send()))
			assert.equal(second, first)
			const digest = listingDigest((JSON.parse(first) as { tools: ToolListing[] }).tools)
			const file = ctx.env.digestFile
			if (!file) return
			const path = `${file}.${ctx.style}`
			if (existsSync(path)) {
				assert.equal(
					readFileSync(path, 'utf8').trim(),
					digest,
					'tools/list changed across a restart',
				)
			} else {
				writeFileSync(path, `${digest}\n`)
			}
		},
	},
	{
		id: 'tools-list-legacy-clean',
		area: 'Tools',
		title: 'Legacy responses carry no modern fields',
		proves:
			'A legacy tools/list result has no cache hints, no resultType and no server info envelope, so a 2025-era client never sees a field it does not know.',
		styles: ['raw-legacy'],
		async run(ctx) {
			const result = rpcResult(await post(ctx.target, legacyRequest('tools/list')))
			for (const key of ['ttlMs', 'cacheScope', 'resultType']) {
				assert.equal(key in result, false, `${key} must not appear on a legacy result`)
			}
		},
	},
	{
		id: 'tools-list-cache-hints',
		area: 'Tools',
		title: 'Modern tools/list and server/discover carry a 5 minute private cache hint',
		proves:
			'Modern clients are told they may cache the tool list for 5 minutes (ttlMs 300000) for this caller only (cacheScope private).',
		styles: ['raw-modern'],
		needs: ['cache-hints'],
		async run(ctx) {
			for (const method of ['tools/list', 'server/discover']) {
				const result = rpcResult(await postModern(ctx.target, method))
				assert.equal(result.ttlMs, 300000, `${method} ttlMs`)
				assert.equal(result.cacheScope, 'private', `${method} cacheScope`)
			}
		},
	},

	// ── tools/call ────────────────────────────────────────────────────────────
	{
		id: 'tools-call-ok',
		area: 'Tools',
		title: 'tools/call runs a tool',
		proves: 'A normal tool call succeeds and returns the tool output for the right workspace.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const outcome = await driver.callTool('get_workspace_schema', {})
			assert.equal(outcome.isError, false, outcome.text.slice(0, 300))
			const schema = JSON.parse(outcome.text) as { workspace_id: string }
			assert.equal(schema.workspace_id, ctx.target.workspaceId)
			await driver.close()
		},
	},
	{
		id: 'tools-call-bad-arguments',
		area: 'Tools',
		title: 'Bad arguments come back as a tool error naming the tool',
		proves:
			'A call with an argument of the wrong type returns an error result (not a crash) that says which tool and that the arguments were invalid.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const outcome = await driver.callTool('get_objects', { ids: 'not-an-array' })
			assert.equal(outcome.isError, true)
			assert.match(outcome.text, /Invalid arguments for tool get_objects/)
			await driver.close()
		},
	},
	{
		id: 'tools-call-unknown-tool',
		area: 'Tools',
		title: 'An unknown tool is reported as not found',
		proves:
			'Calling a tool that does not exist fails with an error that names the tool and says it was not found (invalid params, -32602, when it comes back as a protocol error).',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const outcome = await driver.callTool('no_such_tool', {})
			assert.equal(outcome.isError, true)
			assert.match(outcome.text, /no_such_tool/)
			assert.match(outcome.text, /not found/i)
			if (outcome.errorCode !== undefined) assert.equal(outcome.errorCode, -32602)
			await driver.close()
		},
	},
	{
		id: 'oversize-response-cap',
		area: 'Tools',
		title: 'Oversize list responses are trimmed and say how to fetch the rest',
		proves:
			'When a list result would exceed the response token cap, rows are dropped from the tail, the result is marked truncated and points at get_objects for the omitted rows.',
		styles: ALL,
		needsResponseCap: true,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const nodes = Array.from({ length: 6 }, (_, i) => ({
				$id: `cap-${i}`,
				type: 'insight',
				status: 'new',
				title: `conformance cap row ${i} ${'x'.repeat(300)}`,
			}))
			const created = await driver.callTool('create_objects', {
				workspace_id: ctx.target.workspaceId,
				nodes,
			})
			assert.equal(created.isError, false, created.text.slice(0, 300))
			const listed = await driver.callTool('list_objects', {
				workspace_id: ctx.target.workspaceId,
				type: 'insight',
				limit: 50,
			})
			assert.equal(listed.isError, false, listed.text.slice(0, 300))
			assert.equal(listed.meta?.truncated, true, 'the response must be marked truncated')
			const handle = listed.meta?.fetch_handle as { tool?: string; ids?: string[] } | undefined
			assert.equal(handle?.tool, 'get_objects')
			assert.ok((handle?.ids?.length ?? 0) > 0)
			await driver.close()
		},
	},

	// ── Resources ─────────────────────────────────────────────────────────────
	{
		id: 'resources-list',
		area: 'Resources',
		title: 'resources/list includes the ui:// app views',
		proves: 'The rich-view resources are listed with the MCP app mime type.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const objects = (await driver.listResources()).find((r) => r.uri === 'ui://maskin/objects')
			assert.ok(objects, 'ui://maskin/objects must be listed')
			assert.equal(objects.mimeType, UI_MIME)
			await driver.close()
		},
	},
	{
		id: 'resources-templates',
		area: 'Resources',
		title: 'resources/templates/list returns the object, actor and trigger templates',
		proves: 'The three link templates clients use to open Maskin objects are listed.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const names = (await driver.listResourceTemplates()).map((t) => t.name)
			for (const name of ['maskin-object', 'maskin-actor', 'maskin-trigger']) {
				assert.ok(names.includes(name), `template ${name} must be listed`)
			}
			await driver.close()
		},
	},
	{
		id: 'resources-read-ui',
		area: 'Resources',
		title: 'A ui:// resource reads back as HTML with the app mime type',
		proves: 'Reading ui://maskin/objects returns an HTML document with the MCP app mime type.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver()
			await driver.connect()
			const contents = await driver.readResource('ui://maskin/objects')
			assert.equal(contents[0]?.mimeType, UI_MIME)
			assert.match(contents[0]?.text ?? '', /<(!doctype|html|div|script)/i)
			await driver.close()
		},
	},

	// ── Transport ─────────────────────────────────────────────────────────────
	{
		id: 'get-delete-405',
		area: 'Transport',
		title: 'GET and DELETE are refused with 405',
		proves:
			'The server opens no server-to-client stream and keeps no session to delete, so GET and DELETE answer 405 "Method Not Allowed" without touching the database.',
		styles: RAW,
		async run(ctx) {
			const headers =
				ctx.style === 'raw-modern' ? { 'MCP-Protocol-Version': MODERN_VERSION } : undefined
			for (const method of ['GET', 'DELETE'] as const) {
				const observed = await bare(ctx.target, method, { headers })
				assert.equal(observed.status, 405, method)
				assert.equal(observed.text, 'Method Not Allowed', method)
			}
		},
	},
	{
		id: 'origin-check',
		area: 'Transport',
		title: 'Origin: allowed, denied and absent are all served (report-only)',
		proves:
			'During the report-only phase the Origin check logs but never rejects: an allowed origin, an unknown origin and no Origin at all all get a normal answer. Switching to enforcement changes the denied case and this row.',
		styles: RAW,
		async run(ctx) {
			const modern = ctx.style === 'raw-modern'
			const send = (origin?: string) => {
				const headers = origin ? { Origin: origin } : undefined
				return modern
					? postModern(ctx.target, 'server/discover', {}, { headers })
					: post(ctx.target, legacyRequest('ping'), { headers })
			}
			for (const origin of [ctx.target.webAppOrigin, 'https://not-allowed.example', undefined]) {
				const observed = await send(origin)
				assert.equal(observed.status, 200, `Origin ${origin ?? '(absent)'}`)
				assert.equal(rpc(observed).error, undefined)
			}
		},
	},
	{
		id: 'modern-header-checks',
		area: 'Transport',
		title: 'Modern requests: missing or mismatched headers are rejected',
		proves:
			'A modern request whose Mcp-Method or Mcp-Name header is absent or disagrees with the body is refused with -32020, and one that claims a version in the header but sends no envelope is refused with -32602.',
		styles: ['raw-modern'],
		async run(ctx) {
			const missingMethod = await postModern(
				ctx.target,
				'tools/list',
				{},
				{ omitHeaders: ['Mcp-Method'] },
			)
			const wrongMethod = await postModern(
				ctx.target,
				'tools/list',
				{},
				{ headers: { 'Mcp-Method': 'tools/call' } },
			)
			const wrongName = await postModern(
				ctx.target,
				'tools/call',
				{ name: 'get_workspace_schema', arguments: {} },
				{ headers: { 'Mcp-Name': 'some_other_tool' } },
			)
			const noEnvelope = await postModern(ctx.target, 'tools/list', {}, { noEnvelope: true })
			for (const [label, observed, code] of [
				['missing Mcp-Method', missingMethod, -32020],
				['mismatched Mcp-Method', wrongMethod, -32020],
				['mismatched Mcp-Name', wrongName, -32020],
				['no envelope', noEnvelope, -32602],
			] as const) {
				assert.equal(observed.status, 400, label)
				assert.equal(rpc(observed).error?.code, code, label)
			}
		},
	},
	{
		id: 'unsupported-version',
		area: 'Transport',
		title: 'An unsupported protocol version is refused with the supported list',
		proves:
			'A request claiming a protocol version the server does not speak gets -32022 and a list of the versions it does speak, so a client can correct itself.',
		styles: ['raw-modern'],
		async run(ctx) {
			const observed = await postModern(ctx.target, 'tools/list', {}, { version: '2030-01-01' })
			assert.equal(observed.status, 400)
			const error = rpc(observed).error
			assert.equal(error?.code, -32022)
			assert.ok((error?.data?.supported as string[]).includes(MODERN_VERSION))
		},
	},
	{
		id: 'notification-ack',
		area: 'Transport',
		title: 'Notifications are acknowledged with an empty 202',
		proves: 'A notification (no id) gets 202 and no body, in both eras.',
		styles: RAW,
		async run(ctx) {
			const observed =
				ctx.style === 'raw-modern'
					? await post(
							ctx.target,
							{
								jsonrpc: '2.0',
								method: 'notifications/cancelled',
								params: {
									requestId: 999999,
									_meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION },
								},
							},
							{
								headers: {
									'MCP-Protocol-Version': MODERN_VERSION,
									'Mcp-Method': 'notifications/cancelled',
								},
							},
						)
					: await post(ctx.target, { jsonrpc: '2.0', method: 'notifications/initialized' })
			assert.equal(observed.status, 202)
			assert.equal(observed.text, '')
		},
	},
	{
		id: 'batch-array-legacy',
		area: 'Transport',
		title: 'Legacy JSON-RPC batches are answered with an array, in order',
		proves:
			'A legacy client that sends several requests in one POST gets one array back, matched by id.',
		styles: ['raw-legacy'],
		async run(ctx) {
			const observed = await post(ctx.target, [
				{ jsonrpc: '2.0', id: 'a', method: 'ping' },
				{ jsonrpc: '2.0', id: 'b', method: 'tools/list' },
			])
			assert.equal(observed.status, 200)
			assert.ok(Array.isArray(observed.json))
			const ids = (observed.json as Array<{ id: unknown }>).map((r) => r.id)
			assert.deepEqual([...ids].sort(), ['a', 'b'])
		},
	},
	{
		id: 'malformed-json',
		area: 'Transport',
		title: 'A body that is not JSON gets the same 400 in both eras',
		proves:
			'Malformed JSON is refused before the era is decided, with the same 400 BAD_REQUEST answer for every client.',
		styles: RAW,
		async run(ctx) {
			const headers =
				ctx.style === 'raw-modern' ? { 'MCP-Protocol-Version': MODERN_VERSION } : undefined
			const observed = await post(ctx.target, '{not json', { headers })
			assert.equal(observed.status, 400)
			assert.deepEqual(observed.json, {
				error: { code: 'BAD_REQUEST', message: 'Invalid JSON in request body' },
			})
		},
	},
	{
		id: 'missing-authorization',
		area: 'Transport',
		title: 'No Authorization header: current behaviour, pinned',
		proves:
			'Today the endpoint itself does not require a key: the handshake and tools/list work, and a tool call comes back as a tool-level "Not authenticated" message. This row pins that so changing it (the OAuth work) is a deliberate edit.',
		styles: ALL,
		async run(ctx) {
			const driver = await ctx.driver({ noAuth: true })
			await driver.connect()
			assert.ok((await driver.listTools()).length > 0)
			const outcome = await driver.callTool('get_workspace_schema', {})
			assert.match(outcome.text, /Not authenticated/)
			await driver.close()
		},
	},
	{
		id: 'legacy-json-content-type',
		area: 'Transport',
		title: 'Legacy responses stay application/json',
		proves:
			'Even when a legacy client says it accepts event streams, its answers are plain JSON, never an event stream.',
		styles: ['raw-legacy'],
		async run(ctx) {
			for (const accept of [
				'application/json, text/event-stream',
				'text/event-stream, application/json',
			]) {
				for (const body of [
					legacyInitialize(),
					legacyRequest('tools/list'),
					legacyRequest('tools/call', { name: 'get_workspace_schema', arguments: {} }),
				]) {
					const observed = await post(ctx.target, body, { headers: { Accept: accept } })
					assert.match(
						observed.contentType ?? '',
						/^application\/json/,
						`${body.method} with Accept ${accept}`,
					)
				}
			}
		},
	},
	{
		id: 'stateless-contract',
		area: 'Transport',
		title: 'The server is stateless: no session id minted or echoed',
		proves:
			'No response carries an MCP session id (even when the client sends one), each POST is served by a fresh server (a second initialize is fine, and tools/list works with no handshake first), so nothing is held per connection.',
		styles: RAW,
		async run(ctx) {
			const modern = ctx.style === 'raw-modern'
			const noSessionHeader = (label: string, headers: Record<string, string>) => {
				assert.equal(headers['mcp-session-id'], undefined, `${label} must not carry mcp-session-id`)
			}
			const send = (method: string, headers?: Record<string, string>) =>
				modern
					? postModern(ctx.target, method, {}, { headers })
					: post(ctx.target, legacyRequest(method), { headers })
			noSessionHeader(
				'first request',
				(await send(modern ? 'server/discover' : 'tools/list')).headers,
			)
			noSessionHeader(
				'request that sends a session id',
				(
					await send(modern ? 'server/discover' : 'tools/list', {
						'Mcp-Session-Id': 'client-made-up-session',
					})
				).headers,
			)
			if (!modern) {
				for (const attempt of ['first', 'second']) {
					const observed = await post(ctx.target, legacyInitialize())
					assert.equal(observed.status, 200, `${attempt} initialize`)
					noSessionHeader(`${attempt} initialize`, observed.headers)
				}
			}
		},
	},

	// ── Recorded transcripts and cross-era parity ─────────────────────────────
	{
		id: 'legacy-exact-replay',
		area: 'Compatibility',
		title: 'Recorded v1 requests get the same status, content type and body',
		proves:
			'A fixed set of legacy requests (handshake, notification, ping, unknown tool, bad arguments, no key, batch, GET, DELETE, malformed JSON) is replayed and the answers match what v1 main sent, byte for byte after JSON parsing.',
		styles: ['raw-legacy'],
		async run(ctx) {
			const recorded = fixture<LegacyFixtureFile>('legacy-v1-transcripts.json')
			assert.deepEqual(
				recorded.cases.map((c) => c.id),
				LEGACY_CASES.map((c) => c.id),
				'fixtures are out of date with legacy-cases.ts: re-record from v1 main',
			)
			for (const c of LEGACY_CASES) {
				const live = await runLegacyCase(ctx.target, c)
				const expected = recorded.cases.find((r) => r.id === c.id)?.response as RecordedResponse
				assert.deepEqual(normalise(live), normalise(expected), c.id)
			}
		},
	},
	{
		id: 'era-parity-tools-list',
		area: 'Compatibility',
		title: 'Era parity: modern tools/list matches legacy',
		proves:
			'A modern client and a legacy client see identical tool definitions in identical order (only the schema dialect URI may differ).',
		styles: ['raw-modern'],
		async run(ctx) {
			const legacy = await rawTools(ctx.target, false)
			const modern = await rawTools(ctx.target, true)
			assert.equal(canonicalJson(stripSchemaUri(modern)), canonicalJson(stripSchemaUri(legacy)))
		},
	},
	{
		id: 'era-parity-tool-call',
		area: 'Compatibility',
		title: 'Era parity: the same tool call gives the same answer',
		proves: 'The same call made by a legacy and a modern client returns the same text.',
		styles: MODERN,
		async run(ctx) {
			const legacy = await ctx.driverFor('sdk-legacy')
			const modern = await ctx.driver()
			await legacy.connect()
			await modern.connect()
			const a = await legacy.callTool('get_workspace_schema', {})
			const b = await modern.callTool('get_workspace_schema', {})
			assert.equal(b.isError, a.isError)
			assert.equal(b.text, a.text)
			await legacy.close()
			await modern.close()
		},
	},
	{
		id: 'era-parity-resources',
		area: 'Compatibility',
		title: 'Era parity: resources match',
		proves: 'Both eras list the same resources and templates.',
		styles: MODERN,
		async run(ctx) {
			const legacy = await ctx.driverFor('sdk-legacy')
			const modern = await ctx.driver()
			await legacy.connect()
			await modern.connect()
			assert.deepEqual(await modern.listResources(), await legacy.listResources())
			assert.deepEqual(await modern.listResourceTemplates(), await legacy.listResourceTemplates())
			await legacy.close()
			await modern.close()
		},
	},
]
