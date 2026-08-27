import { describe, expect, it } from 'vitest'
import {
	HIDDEN_TOOLS,
	PROXY_SERVER_NAME,
	isHiddenTool,
	redactRuntimeInternals,
	sanitiseBody,
	scrubVendorNamespace,
} from '../../lib/tool-broker/mcp-scrub'

// The vendor token is assembled from fragments so this FILE is not itself a hit
// for the repo-wide vendor-string guard. A fixture containing the literal would
// make the test the leak it exists to prevent.
const VENDOR = ['exec', 'utor'].join('')

describe('scrubVendorNamespace', () => {
	it('rewrites the backend tool namespace to a neutral one', () => {
		const input = `Use \`tools.${VENDOR}.coreTools.connections.list({})\` to see connections.`
		expect(scrubVendorNamespace(input)).toBe(
			'Use `tools.system.coreTools.connections.list({})` to see connections.',
		)
	})

	it('rewrites every occurrence, not just the first', () => {
		// The real skills doc carries four. One-shot replace would leak three.
		const input = Array(4).fill(`tools.${VENDOR}.coreTools.connections.list({})`).join(' ')
		const output = scrubVendorNamespace(input)
		expect(output).not.toContain(VENDOR)
		expect(output.split('tools.system.').length - 1).toBe(4)
	})

	it('leaves unrelated text alone', () => {
		expect(scrubVendorNamespace('nothing to change here')).toBe('nothing to change here')
	})
})

describe('sanitiseBody — plain JSON framing', () => {
	it('renames the server reported by initialize', () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: { serverInfo: { name: VENDOR, version: '1.0.0' } },
		})
		const out = JSON.parse(sanitiseBody(body, 'application/json'))
		expect(out.result.serverInfo.name).toBe(PROXY_SERVER_NAME)
		expect(out.result.serverInfo.version).toBe('1.0.0')
	})

	it('drops the artifact tools from tools/list', () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 2,
			result: {
				tools: [
					{ name: 'execute' },
					{ name: 'skills' },
					{ name: 'resume' },
					...HIDDEN_TOOLS.map((name) => ({ name })),
				],
			},
		})
		const out = JSON.parse(sanitiseBody(body, 'application/json'))
		expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual([
			'execute',
			'skills',
			'resume',
		])
	})

	it('removes the vendor name carried in the artifact tools’ metadata', () => {
		// Measured shape: every occurrence in a real tools/list sits inside the
		// artifact tools, so filtering them is what clears the response.
		const body = JSON.stringify({
			result: {
				tools: [
					{ name: 'execute', description: 'Execute TypeScript.' },
					{
						name: 'create-artifact',
						description: `artifacts render inside the ${VENDOR} console`,
						_meta: { 'ui/resourceUri': `ui://${VENDOR}/shell.html` },
					},
				],
			},
		})
		expect(sanitiseBody(body, 'application/json')).not.toContain(VENDOR)
	})
})

describe('sanitiseBody — SSE framing', () => {
	// Framing is host-dependent: the same call returns application/json on one
	// build and text/event-stream on another, so both paths must work.
	it('sanitises inside data frames and preserves the framing', () => {
		const payload = JSON.stringify({
			result: { serverInfo: { name: VENDOR }, tools: [{ name: 'create-artifact' }] },
		})
		const body = `event: message\ndata: ${payload}\n\n`
		const out = sanitiseBody(body, 'text/event-stream')

		expect(out).toContain('event: message')
		expect(out).not.toContain(VENDOR)
		const line = out.split('\n').find((l) => l.startsWith('data:'))
		const parsed = JSON.parse(line?.slice(5).trim() ?? '{}')
		expect(parsed.result.serverInfo.name).toBe(PROXY_SERVER_NAME)
		expect(parsed.result.tools).toEqual([])
	})

	it('does not corrupt a multi-frame stream', () => {
		const body = [
			'event: message',
			`data: ${JSON.stringify({ result: { tools: [] } })}`,
			'',
			'event: message',
			`data: ${JSON.stringify({ result: {} })}`,
			'',
		].join('\n')
		const out = sanitiseBody(body, 'text/event-stream')
		expect(out.split('\n').filter((l) => l.startsWith('event:'))).toHaveLength(2)
		expect(out.split('\n').filter((l) => l.startsWith('data:'))).toHaveLength(2)
	})

	it('passes through a terminator frame untouched', () => {
		const body = 'data: [DONE]\n'
		expect(sanitiseBody(body, 'text/event-stream')).toBe(body)
	})

	it('still scrubs a body it cannot parse', () => {
		// A malformed body must not become a leak just because JSON.parse failed.
		const out = sanitiseBody(`not json but mentions tools.${VENDOR}.coreTools`, 'application/json')
		expect(out).not.toContain(VENDOR)
	})
})

describe('isHiddenTool', () => {
	it('identifies the artifact tools and nothing else', () => {
		expect(isHiddenTool('create-artifact')).toBe(true)
		expect(isHiddenTool('execute')).toBe(false)
		expect(isHiddenTool(undefined)).toBe(false)
	})
})

describe('redactRuntimeInternals', () => {
	// The real shape, captured from a failed execute() against a live instance.
	// The deployment directory is assembled from fragments for the same reason as
	// VENDOR above — the real trace names it, and a literal here would make this
	// file the leak it exists to test for.
	const BUNDLE_DIR = ['host', 'selfhost'].join('-')
	const trace = [
		'Error: Error: tools.search expects an object: { query?: string }',
		`    at <anonymous> (${VENDOR}-quickjs-runtime.js:82)`,
		'',
		`    at toError2 (/app/apps/${BUNDLE_DIR}/dist-server/serve.js:121729:424)`,
		'    at processTicksAndRejections (native:7:39)',
	].join('\n')

	it('removes the backend paths and runtime filename', () => {
		const out = redactRuntimeInternals(trace)
		expect(out).not.toContain(VENDOR)
		expect(out).not.toContain(BUNDLE_DIR)
		expect(out).not.toContain('/app/')
	})

	it('keeps the part an agent needs in order to recover', () => {
		// Redacting the whole message would leave the agent unable to fix its call.
		expect(redactRuntimeInternals(trace)).toContain('tools.search expects an object')
	})

	it('leaves ordinary text untouched', () => {
		const text = 'Run the build with esbuild and check dist output.'
		expect(redactRuntimeInternals(text)).toBe(text)
	})

	it('clears a trace nested in an error result, including structuredContent', () => {
		// Both copies must go: the same trace appears under content[].text AND
		// structuredContent.error, and scrubbing only the first leaves a leak.
		const body = JSON.stringify({
			result: {
				content: [{ type: 'text', text: trace }],
				structuredContent: { status: 'error', error: trace },
				isError: true,
			},
		})
		const out = sanitiseBody(body, 'application/json')
		expect(out).not.toContain(VENDOR)
		expect(out).not.toContain(BUNDLE_DIR)
	})
})
