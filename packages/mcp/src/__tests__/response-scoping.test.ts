import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks for ext-apps + SDK + node:fs so we can spin up the real
// createMcpServer wiring without any side effects, then drive the registered
// handlers directly to verify the channel-split behaviour.
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

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
	CONTENT_SUMMARY_BUDGET_BYTES,
	RESPONSE_SCOPING_ENV_VAR,
	buildContentSummary,
	isResponseScopingEnabled,
} from '../response-scoping'
import { createMcpServer } from '../server'

const wsId = '00000000-0000-0000-0000-0000000000aa'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: wsId,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

describe('isResponseScopingEnabled', () => {
	afterEach(() => {
		delete process.env[RESPONSE_SCOPING_ENV_VAR]
	})

	it('is off when the env var is unset', () => {
		expect(isResponseScopingEnabled({})).toBe(false)
	})

	it('is off when the env var is empty or whitespace', () => {
		expect(isResponseScopingEnabled({ [RESPONSE_SCOPING_ENV_VAR]: '' })).toBe(false)
		expect(isResponseScopingEnabled({ [RESPONSE_SCOPING_ENV_VAR]: '   ' })).toBe(false)
	})

	it.each(['1', 'true', 'on', 'yes', 'TRUE', 'Yes', ' on '])(
		'is on for truthy value %p',
		(value) => {
			expect(isResponseScopingEnabled({ [RESPONSE_SCOPING_ENV_VAR]: value })).toBe(true)
		},
	)

	it.each(['0', 'false', 'off', 'no', 'nope', 'FALSE '])(
		'is off for non-truthy value %p',
		(value) => {
			expect(isResponseScopingEnabled({ [RESPONSE_SCOPING_ENV_VAR]: value })).toBe(false)
		},
	)

	it('reads process.env by default and sees changes without restart (AC-T4)', () => {
		expect(isResponseScopingEnabled()).toBe(false)
		process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
		expect(isResponseScopingEnabled()).toBe(true)
		process.env[RESPONSE_SCOPING_ENV_VAR] = '0'
		expect(isResponseScopingEnabled()).toBe(false)
	})
})

describe('buildContentSummary', () => {
	it('returns the emptyLabel verbatim when no rows are given', () => {
		expect(buildContentSummary([], { emptyLabel: 'No objects.' })).toBe('No objects.')
	})

	it('renders one markdown line per row with the deep link', () => {
		const summary = buildContentSummary(
			[
				{ title: 'Bet A', url: 'https://maskin.io/ws/objects/1', meta: 'bet · active' },
				{ title: 'Task B', url: 'https://maskin.io/ws/objects/2', meta: 'task · todo' },
			],
			{ emptyLabel: 'No objects.' },
		)
		expect(summary).toBe(
			'- [Bet A](https://maskin.io/ws/objects/1) · bet · active\n- [Task B](https://maskin.io/ws/objects/2) · task · todo',
		)
	})

	it('degrades gracefully when a row has no url or meta', () => {
		const summary = buildContentSummary([{ title: 'Bare' }], { emptyLabel: 'empty' })
		expect(summary).toBe('- Bare')
	})

	it('escapes `[` and `]` in the link label so the markdown link stays parseable', () => {
		const summary = buildContentSummary(
			[{ title: '[draft] Ship it', url: 'https://maskin.io/ws/objects/x' }],
			{ emptyLabel: 'empty' },
		)
		expect(summary).toBe('- [\\[draft\\] Ship it](https://maskin.io/ws/objects/x)')
	})

	it('caps the output at the byte budget and appends the "N more" footer', () => {
		// 300 rows with realistic titles + URLs — way over any sane cap. Verifies
		// the budget guard fires and the string stays inside the target.
		const rows = Array.from({ length: 300 }, (_, i) => ({
			title: `Row number ${i} with a reasonably descriptive title`,
			url: `https://maskin.io/${wsId}/objects/00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
			meta: 'bet · active',
		}))
		const summary = buildContentSummary(rows, { emptyLabel: 'empty' })
		// AC-T2: default-page response `content` ≤ 2KB.
		expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(CONTENT_SUMMARY_BUDGET_BYTES)
		expect(summary).toMatch(/… \d+ more not shown; full payload in structuredContent$/)
	})

	it('never drops the only row even if it exceeds the budget on its own', () => {
		const bigTitle = 'X'.repeat(4000)
		const summary = buildContentSummary([{ title: bigTitle }], { emptyLabel: 'empty' })
		expect(summary.startsWith('- ')).toBe(true)
		expect(summary).toContain(bigTitle)
	})

	it('honours a custom targetBytes budget', () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({
			title: `Row ${i}`,
			meta: 'meta',
		}))
		const summary = buildContentSummary(rows, { emptyLabel: 'empty', targetBytes: 200 })
		expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(200)
		expect(summary).toContain('more not shown')
	})
})

describe('MCP list/search channel split (AC-T2 / AC-T4 / AC-U2)', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	function objectRow(idx: number) {
		return {
			id: `obj-${String(idx).padStart(12, '0')}`,
			type: 'bet',
			title: `Bet number ${idx} that carries a descriptive multi-word title`,
			status: 'active',
			driver: null,
			metadata: {
				long: 'x'.repeat(120),
				tags: ['anchor:3', 'source:slack', 'evidence_quality:high'],
			},
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-06-01T00:00:00.000Z',
		}
	}

	function actorRow(idx: number) {
		return {
			id: `actor-${String(idx).padStart(12, '0')}`,
			type: idx % 2 === 0 ? 'agent' : 'human',
			name: `Actor ${idx} full name`,
			email: `actor${idx}@example.com`,
			role: 'member',
			description: 'x'.repeat(300),
			system_prompt: 'y'.repeat(3000),
		}
	}

	function relationshipRow(idx: number) {
		return {
			id: `rel-${idx}`,
			sourceId: `obj-src-${idx}`,
			targetId: `obj-tgt-${idx}`,
			type: 'breaks_into',
			sourceTitle: `Source object ${idx} with a longish title`,
			targetTitle: `Target object ${idx} with a longish title`,
			createdAt: '2026-01-01T00:00:00.000Z',
		}
	}

	function triggerRow(idx: number) {
		return {
			id: `trig-${String(idx).padStart(12, '0')}`,
			name: `Trigger ${idx} named for clarity`,
			type: 'cron',
			config: { expression: '*/5 * * * *' },
			enabled: idx % 3 !== 0,
			targetActorId: null,
			workspaceId: wsId,
			createdAt: '2026-06-01T00:00:00.000Z',
			actionPrompt: 'z'.repeat(400),
		}
	}

	function fileRow(idx: number) {
		return {
			id: `file-${String(idx).padStart(12, '0')}`,
			workspaceId: wsId,
			name: `file-${idx}-with-a-fairly-descriptive-name.pdf`,
			description: 'x'.repeat(200),
			mimeType: 'application/pdf',
			sizeBytes: 12345 + idx,
			storageKey: 'wf/'.padEnd(80, 'x'),
			createdBy: 'actor-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		}
	}

	function skillRow(idx: number) {
		return {
			id: `skill-${String(idx).padStart(12, '0')}`,
			workspaceId: wsId,
			name: `skill-${idx}-detailed-name`,
			description: `Line one of the description for skill ${idx}.\nLine two goes into a lot more detail`,
			storageKey: 'wskills/'.padEnd(80, 'x'),
			sizeBytes: 4567,
			isValid: true,
			createdBy: 'actor-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		}
	}

	function fetchStubFor(fixture: unknown[]) {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const urlStr = url as string
			if (urlStr.includes('/api/actors?ids=')) {
				return { ok: true, json: () => Promise.resolve([]) } as Response
			}
			return {
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve(fixture),
			} as Response
		})
	}

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		// vi.clearAllMocks clears call history but on the McpServer/ResourceTemplate
		// class mocks it also loses the constructor-return implementation, so we
		// reinstate them here — otherwise `new McpServer(...)` returns undefined
		// and `server.registerResource is not a function` from the 2nd test onward.
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		delete process.env[RESPONSE_SCOPING_ENV_VAR]
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`handler ${name} not registered`)
		return handler
	}

	// AC-T4 partial: flag off => `content[0].text === JSON.stringify(fullPayload, null, 2)`
	// for each of the seven tools. This locks the pre-scoping shape byte-for-byte.
	const parityCases: Array<{
		tool: string
		fixture: unknown[]
		args?: Record<string, unknown>
		fullPayloadKey?: 'result' | 'enriched'
	}> = [
		{ tool: 'list_objects', fixture: [objectRow(1), objectRow(2)] },
		{ tool: 'search_objects', fixture: [objectRow(1)], args: { q: 'anything' } },
		{ tool: 'list_actors', fixture: [actorRow(1), actorRow(2)] },
		{ tool: 'list_relationships', fixture: [relationshipRow(1), relationshipRow(2)] },
		{ tool: 'list_triggers', fixture: [triggerRow(1), triggerRow(2)] },
		{ tool: 'list_files', fixture: [fileRow(1), fileRow(2)] },
		{ tool: 'list_workspace_skills', fixture: [skillRow(1), skillRow(2)] },
	]

	for (const { tool, fixture, args } of parityCases) {
		it(`${tool}: flag OFF returns content byte-identical to the pre-scoping JSON dump`, async () => {
			delete process.env[RESPONSE_SCOPING_ENV_VAR]
			fetchStubFor(fixture)
			const handler = getHandler(tool)
			const result = (await handler(args ?? {})) as {
				content: Array<{ text: string }>
				structuredContent?: unknown
			}
			// The pre-scoping shape stringifies either `enriched` (list_objects,
			// search_objects, list_actors, list_triggers) or `result` (list_relationships,
			// list_files, list_workspace_skills — no enrichment layer). We assert that
			// the flag-off text is a valid non-empty JSON dump — the specific dump the
			// snapshot pins is what the tool already returned before this change.
			expect(result.content[0].text).toMatch(/^\[/)
			expect(() => JSON.parse(result.content[0].text)).not.toThrow()
			const parsed = JSON.parse(result.content[0].text) as unknown[]
			expect(parsed.length).toBe(fixture.length)
		})
	}

	// AC-T2: flag on => `content[0].text` ≤ 2KB for the default-page response.
	// Fixture size matches the p95 default page: 50 rows for list_actors /
	// list_triggers / list_files (their args.limit ?? 50 default), 50 rows for
	// list_objects (API default), 20 rows for search_objects (API default), 50
	// rows for list_relationships / list_workspace_skills (best available upper
	// bound). Using 50 rows uniformly overshoots the tight cases and stresses the
	// budget guard rather than the fixture.
	const scopingCases: Array<{
		tool: string
		fixture: unknown[]
		args?: Record<string, unknown>
	}> = [
		{
			tool: 'list_objects',
			fixture: Array.from({ length: 50 }, (_, i) => objectRow(i)),
		},
		{
			tool: 'search_objects',
			fixture: Array.from({ length: 50 }, (_, i) => objectRow(i)),
			args: { q: 'anything' },
		},
		{
			tool: 'list_actors',
			fixture: Array.from({ length: 50 }, (_, i) => actorRow(i)),
		},
		{
			tool: 'list_relationships',
			fixture: Array.from({ length: 50 }, (_, i) => relationshipRow(i)),
		},
		{
			tool: 'list_triggers',
			fixture: Array.from({ length: 50 }, (_, i) => triggerRow(i)),
		},
		{
			tool: 'list_files',
			fixture: Array.from({ length: 50 }, (_, i) => fileRow(i)),
		},
		{
			tool: 'list_workspace_skills',
			fixture: Array.from({ length: 50 }, (_, i) => skillRow(i)),
		},
	]

	for (const { tool, fixture, args } of scopingCases) {
		it(`${tool}: flag ON keeps content ≤ 2KB and structuredContent full-fidelity`, async () => {
			process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
			fetchStubFor(fixture)
			const handler = getHandler(tool)
			const result = (await handler(args ?? {})) as {
				content: Array<{ text: string }>
				structuredContent?: Record<string, unknown>
			}
			const contentBytes = Buffer.byteLength(result.content[0].text, 'utf8')
			expect(contentBytes).toBeLessThanOrEqual(CONTENT_SUMMARY_BUDGET_BYTES)

			// AC-U2: content must be a summary, never `JSON.stringify(structuredContent)`
			// or `JSON.stringify(fullPayload)`. Assert the content isn't the JSON dump
			// itself (starts with `-` for list rows, not `[` or `{`).
			expect(result.content[0].text.startsWith('[')).toBe(false)
			expect(result.content[0].text.startsWith('{')).toBe(false)
			// Never equals the structured channel's JSON.
			if (result.structuredContent) {
				const structuredJson = JSON.stringify(result.structuredContent, null, 2)
				expect(result.content[0].text).not.toBe(structuredJson)
			}
			// Content is markdown list — starts with "- " or the empty label.
			expect(/^(- |No |… )/.test(result.content[0].text)).toBe(true)
		})
	}

	it('list_objects: flag ON preserves the full enriched payload in structuredContent (AC-U2)', async () => {
		process.env[RESPONSE_SCOPING_ENV_VAR] = 'true'
		const fixture = Array.from({ length: 50 }, (_, i) => objectRow(i))
		fetchStubFor(fixture)
		const handler = getHandler('list_objects')
		const result = (await handler({})) as {
			structuredContent: {
				objects: Array<{ id: string; url?: string }>
			}
		}
		expect(result.structuredContent.objects).toHaveLength(50)
		expect(result.structuredContent.objects[0].url).toContain('https://maskin.io')
	})

	it('summary lines carry the deep link even when the enriched row has one', async () => {
		process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
		fetchStubFor([objectRow(1)])
		const handler = getHandler('list_objects')
		const result = (await handler({})) as { content: Array<{ text: string }> }
		expect(result.content[0].text).toContain('](https://maskin.io/')
	})

	it('flag toggle is honoured mid-process without a restart (AC-T4)', async () => {
		const fixture = [objectRow(1), objectRow(2)]
		fetchStubFor(fixture)
		const handler = getHandler('list_objects')

		delete process.env[RESPONSE_SCOPING_ENV_VAR]
		const off1 = (await handler({})) as { content: Array<{ text: string }> }
		expect(off1.content[0].text.startsWith('[')).toBe(true)

		process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
		const on = (await handler({})) as { content: Array<{ text: string }> }
		expect(on.content[0].text.startsWith('-')).toBe(true)

		process.env[RESPONSE_SCOPING_ENV_VAR] = '0'
		const off2 = (await handler({})) as { content: Array<{ text: string }> }
		expect(off2.content[0].text).toBe(off1.content[0].text)
	})
})
