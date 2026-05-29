import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	type FormatterContext,
	escapeMd,
	formatMutationConfirm,
	formatObject,
	formatObjectBatch,
	formatObjectList,
	formatSearchHits,
	formatUnreadDigest,
	formatWorkspaceSummary,
} from '../formatters'

const WS = '11111111-1111-1111-1111-111111111111'
const OID = '22222222-2222-2222-2222-222222222222'
const OID2 = '33333333-3333-3333-3333-333333333333'

const ENV_KEYS = ['WEB_APP_URL', 'FRONTEND_URL'] as const

const baseCtx = (overrides: Partial<FormatterContext> = {}): FormatterContext => ({
	workspaceId: WS,
	tool: 'unit_test',
	...overrides,
})

describe('formatters', () => {
	const originalEnv: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const k of ENV_KEYS) {
			originalEnv[k] = process.env[k]
			delete process.env[k]
		}
	})

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (originalEnv[k] === undefined) delete process.env[k]
			else process.env[k] = originalEnv[k]
		}
	})

	describe('formatObject', () => {
		const graph = {
			object: {
				id: OID,
				type: 'task',
				title: 'Ship the formatter',
				status: 'in_progress',
				content: 'Build markdown summary formatters for the MCP tool results.',
			},
			events: [
				{
					id: 1,
					action: 'commented',
					description: 'sindre: lgtm',
					createdAt: '2026-05-27T09:00:00Z',
				},
			],
		}

		it('renders H4 title with the object deep link', () => {
			const out = formatObject(graph, baseCtx({ tool: 'get_objects' }))
			expect(out.content).toContain(
				`#### [Ship the formatter](https://maskin.app/r/${WS}/objects/${OID}?t=get_objects)`,
			)
		})

		it('includes type and status as the meta line', () => {
			const out = formatObject(graph, baseCtx())
			expect(out.content).toContain('_task • in_progress_')
		})

		it('includes a content preview, truncated to one line', () => {
			const long = 'x'.repeat(500)
			const out = formatObject(
				{ object: { ...graph.object, content: long }, events: [] },
				baseCtx(),
			)
			expect(out.content.split('\n').some((l) => l.endsWith('…'))).toBe(true)
		})

		it('surfaces the last activity description', () => {
			const out = formatObject(graph, baseCtx())
			expect(out.content).toContain('Last activity: sindre: lgtm')
		})

		it('falls back to "Untitled" when title is missing', () => {
			const out = formatObject({ object: { id: OID, type: 'task' }, events: [] }, baseCtx())
			expect(out.content).toContain('Untitled task')
		})

		it('carries the full graph as structuredContent', () => {
			const out = formatObject(graph, baseCtx())
			expect(out.structuredContent).toBe(graph)
		})

		it('mentions attached files when present', () => {
			const out = formatObject(
				{
					...graph,
					files: [{ id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1, url: 'x' }],
				},
				baseCtx(),
			)
			expect(out.content).toContain('1 attached file')
		})
	})

	describe('formatObjectBatch', () => {
		const ok = {
			id: OID,
			success: true,
			result: {
				object: { id: OID, type: 'bet', title: 'Lean MCP', status: 'active' },
				events: [],
			},
		}
		const bad = { id: OID2, success: false, error: 'Object not found' }

		it('renders each successful entry with a deep link', () => {
			const out = formatObjectBatch([ok], baseCtx({ tool: 'get_objects' }))
			expect(out.content).toContain(`/objects/${OID}?t=get_objects`)
		})

		it('renders failures as a one-line warning', () => {
			const out = formatObjectBatch([bad], baseCtx())
			expect(out.content).toContain(`⚠️ \`${OID2}\` — Object not found`)
		})

		it('handles mixed success and failure', () => {
			const out = formatObjectBatch([ok, bad], baseCtx())
			expect(out.content).toContain('Lean MCP')
			expect(out.content).toContain('Object not found')
		})

		it('emits an empty-state placeholder when given no results', () => {
			const out = formatObjectBatch([], baseCtx())
			expect(out.content).toBe('_No objects returned._')
		})

		it('passes results through as structuredContent', () => {
			const out = formatObjectBatch([ok, bad], baseCtx())
			expect(out.structuredContent).toEqual([ok, bad])
		})
	})

	describe('formatObjectList', () => {
		it('groups items by type, with a heading per bucket', () => {
			const out = formatObjectList(
				[
					{ id: OID, type: 'bet', title: 'B1', status: 'active' },
					{ id: OID2, type: 'task', title: 'T1', status: 'todo' },
					{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'task', title: 'T2', status: 'todo' },
				],
				baseCtx(),
			)
			expect(out.content).toContain('**1 bet**')
			expect(out.content).toContain('**2 tasks**')
		})

		it('renders each item as an H4 with a deep link', () => {
			const out = formatObjectList(
				[{ id: OID, type: 'task', title: 'One', status: 'todo' }],
				baseCtx({ tool: 'list_objects' }),
			)
			expect(out.content).toContain(
				`#### [One](https://maskin.app/r/${WS}/objects/${OID}?t=list_objects)`,
			)
		})

		it('truncates very long pages with an "…and N more" suffix', () => {
			const many = Array.from({ length: 30 }, (_, i) => ({
				id: `${i.toString().padStart(8, '0')}-0000-0000-0000-000000000000`,
				type: 'task',
				title: `T${i}`,
				status: 'todo',
			}))
			const out = formatObjectList(many, baseCtx())
			expect(out.content).toMatch(/…and 5 more/)
		})

		it('emits an empty-state placeholder for an empty page', () => {
			const out = formatObjectList([], baseCtx())
			expect(out.content).toBe('_No objects matched._')
		})
	})

	describe('formatSearchHits', () => {
		const hits = [
			{ id: OID, type: 'bet', title: 'Hello world', status: 'active', content: 'matched' },
		]

		it('puts the query in a headline alongside a search deep link', () => {
			const out = formatSearchHits({ q: 'launch', hits }, baseCtx({ tool: 'search_objects' }))
			expect(out.content).toContain(
				`**1 result** for "launch" — [open in Maskin](https://maskin.app/r/${WS}/objects?q=launch&t=search_objects)`,
			)
		})

		it('renders each hit with a deep link', () => {
			const out = formatSearchHits({ q: 'x', hits }, baseCtx({ tool: 'search_objects' }))
			expect(out.content).toContain(`/objects/${OID}?t=search_objects`)
		})

		it('reports zero matches without an empty list', () => {
			const out = formatSearchHits({ q: 'nope', hits: [] }, baseCtx())
			expect(out.content).toContain('**0 results** for "nope"')
			expect(out.content).toContain('_No matches._')
		})

		it('carries the hits array as structuredContent', () => {
			const out = formatSearchHits({ q: 'x', hits }, baseCtx())
			expect(out.structuredContent).toBe(hits)
		})
	})

	describe('formatUnreadDigest', () => {
		const items = [
			{
				entity_type: 'object',
				entity_id: OID,
				unread_count: 3,
				latest_event_id: 42,
				latest_activity_at: '2026-05-27T09:00:00Z',
				object: { id: OID, type: 'task', title: 'Task A', status: 'in_progress' },
			},
			{
				entity_type: 'object',
				entity_id: OID2,
				unread_count: 1,
				latest_event_id: 41,
				latest_activity_at: '2026-05-27T08:00:00Z',
				object: { id: OID2, type: 'bet', title: 'Bet B', status: 'active' },
			},
		]

		it('headlines the total unread count and links to the activity view', () => {
			const out = formatUnreadDigest({ items }, baseCtx({ tool: 'list_unread' }))
			expect(out.content).toContain('**4 unread** across 2 threads')
			expect(out.content).toContain('/activity?t=list_unread')
		})

		it('renders one bulleted line per item with a deep link', () => {
			const out = formatUnreadDigest({ items }, baseCtx())
			expect(out.content).toContain('- [Task A]')
			expect(out.content).toContain('— 3 unread')
		})

		it('emits "Inbox zero." when there are no unread items', () => {
			const out = formatUnreadDigest({ items: [] }, baseCtx())
			expect(out.content).toContain('_Inbox zero._')
		})

		it('falls back to entity_type + short id when no object is hydrated', () => {
			const out = formatUnreadDigest(
				{ items: [{ entity_type: 'session', entity_id: OID, unread_count: 1 }] },
				baseCtx(),
			)
			expect(out.content).toContain(`session ${OID.slice(0, 8)}`)
		})
	})

	describe('formatWorkspaceSummary', () => {
		const schema = {
			workspace_id: WS,
			workspace_name: 'Acme',
			relationship_types: ['informs', 'blocks'],
			types: {
				bet: { display_name: 'Bet', statuses: ['active', 'paused'] },
				task: { display_name: 'Task', statuses: ['todo', 'in_progress', 'done'] },
			},
		}

		it('headlines the workspace name with a workspace deep link', () => {
			const out = formatWorkspaceSummary(schema, baseCtx({ tool: 'get_workspace_schema' }))
			expect(out.content).toContain(
				`#### [Acme](https://maskin.app/r/${WS}?t=get_workspace_schema)`,
			)
		})

		it('lists each type and its statuses on one line', () => {
			const out = formatWorkspaceSummary(schema, baseCtx())
			expect(out.content).toContain('- **Bet** — statuses: active, paused')
			expect(out.content).toContain('- **Task** — statuses: todo, in_progress, done')
		})

		it('lists relationship types as a trailing line', () => {
			const out = formatWorkspaceSummary(schema, baseCtx())
			expect(out.content).toContain('Relationship types: informs, blocks')
		})

		it('handles a schema with no types gracefully', () => {
			const out = formatWorkspaceSummary({ workspace_id: WS, workspace_name: 'Bare' }, baseCtx())
			expect(out.content).toContain('#### [Bare]')
		})
	})

	describe('escapeMd', () => {
		it('escapes link-syntax brackets and code-span backticks', () => {
			expect(escapeMd('foo](evil) [bar')).toBe('foo\\](evil) \\[bar')
			expect(escapeMd('a`b`c')).toBe('a\\`b\\`c')
		})

		it('escapes backslashes before other passes so escapes do not collapse', () => {
			expect(escapeMd('a\\b')).toBe('a\\\\b')
			expect(escapeMd('a\\]b')).toBe('a\\\\\\]b')
		})

		it('collapses CR/LF to a single space so smuggled lines stay on one row', () => {
			expect(escapeMd('one\ntwo')).toBe('one two')
			expect(escapeMd('one\r\ntwo')).toBe('one two')
			expect(escapeMd('one\n\n\ntwo')).toBe('one two')
		})

		it('leaves common punctuation alone', () => {
			expect(escapeMd('foo (bar) *baz* _qux_ #1')).toBe('foo (bar) *baz* _qux_ #1')
		})

		it('passes ordinary titles through unchanged', () => {
			expect(escapeMd('Ship the formatter')).toBe('Ship the formatter')
		})
	})

	describe('markdown-injection defenses', () => {
		// A malicious title that, if interpolated raw into `[${title}](url)`,
		// breaks out of the link text and creates a second `[bar](url)` link.
		// We check that every `](` in the rendered output is preceded by `\`
		// (escaped) so no extra link target survives.
		const malicious = 'foo](http://evil) [bar'
		const noUnescapedLinkClose = (s: string) => {
			// Look for `](` not preceded by a backslash. URL-encoded `%5D(` and
			// our escape `\](` are both fine. The only intact `](` should be
			// the legitimate deep-link's closing one — strip those before the
			// check so the assertion is about user-text breakouts.
			const stripped = s.replaceAll(/\]\(https:\/\/maskin\.app\/[^)]*\)/g, '<DEEPLINK>')
			return !/(?<!\\)\]\(/.test(stripped)
		}

		it('keeps the deep link intact when an object title carries link syntax', () => {
			const out = formatObject(
				{
					object: { id: OID, type: 'task', title: malicious, status: 'todo' },
					events: [],
				},
				baseCtx({ tool: 'get_objects' }),
			)
			expect(out.content).toContain(
				`#### [foo\\](http://evil) \\[bar](https://maskin.app/r/${WS}/objects/${OID}?t=get_objects)`,
			)
			expect(noUnescapedLinkClose(out.content)).toBe(true)
		})

		it('keeps the deep link intact in batch rendering with a malicious title', () => {
			const out = formatObjectBatch(
				[
					{
						id: OID,
						success: true,
						result: {
							object: { id: OID, type: 'task', title: malicious, status: 'todo' },
							events: [],
						},
					},
				],
				baseCtx({ tool: 'get_objects' }),
			)
			expect(out.content).toContain(`/objects/${OID}?t=get_objects`)
			expect(noUnescapedLinkClose(out.content)).toBe(true)
		})

		it('defangs malicious content in the search query header', () => {
			const out = formatSearchHits({ q: malicious, hits: [] }, baseCtx({ tool: 'search_objects' }))
			expect(out.content).toContain('foo\\](http://evil) \\[bar')
			expect(noUnescapedLinkClose(out.content)).toBe(true)
		})

		it('defangs a malicious workspace_name', () => {
			const out = formatWorkspaceSummary(
				{ workspace_id: WS, workspace_name: malicious },
				baseCtx({ tool: 'get_workspace_schema' }),
			)
			expect(out.content).toContain('foo\\](http://evil) \\[bar')
			expect(noUnescapedLinkClose(out.content)).toBe(true)
		})

		it('defangs preview snippets with backticks and newlines', () => {
			const out = formatObject(
				{
					object: {
						id: OID,
						type: 'task',
						title: 'ok',
						status: 'todo',
						content: 'pre `evil` post\nsecond line',
					},
					events: [],
				},
				baseCtx(),
			)
			expect(out.content).toContain('pre \\`evil\\` post second line')
		})

		it('defangs event descriptions in the Last activity line', () => {
			const out = formatObject(
				{
					object: { id: OID, type: 'task', title: 'ok', status: 'todo' },
					events: [{ id: 1, action: 'commented', description: malicious }],
				},
				baseCtx(),
			)
			expect(out.content).toContain('Last activity: foo\\](http://evil) \\[bar')
			expect(noUnescapedLinkClose(out.content)).toBe(true)
		})

		it('defangs error strings in formatMutationConfirm rows', () => {
			const out = formatMutationConfirm(
				{
					verb: 'delete_object',
					results: [{ id: OID, success: false, error: malicious }],
				},
				baseCtx({ tool: 'delete_object' }),
			)
			expect(out.content).toContain('foo\\](http://evil) \\[bar')
			expect(noUnescapedLinkClose(out.content)).toBe(true)
		})
	})

	describe('formatMutationConfirm', () => {
		it('renders a green-checkmark line when all results succeeded', () => {
			const out = formatMutationConfirm(
				{
					verb: 'create_objects',
					results: [
						{
							type: 'object',
							id: OID,
							success: true,
							result: { id: OID, title: 'X', type: 'task' },
						},
					],
				},
				baseCtx({ tool: 'create_objects' }),
			)
			expect(out.content).toMatch(/^✅ \*\*create_objects\*\*: 1 succeeded/)
			expect(out.content).toContain(`/objects/${OID}?t=create_objects`)
		})

		it('renders a red-x line when all results failed', () => {
			const out = formatMutationConfirm(
				{ verb: 'delete_object', results: [{ id: OID, success: false, error: 'NOT_FOUND' }] },
				baseCtx(),
			)
			expect(out.content).toMatch(/^❌ \*\*delete_object\*\*: 0 succeeded, 1 failed/)
			expect(out.content).toContain('NOT_FOUND')
		})

		it('renders a warning when results are mixed', () => {
			const out = formatMutationConfirm(
				{
					verb: 'update_objects',
					results: [
						{ id: OID, success: true, result: { id: OID, title: 'X', type: 'task' } },
						{ id: OID2, success: false, error: 'boom' },
					],
				},
				baseCtx(),
			)
			expect(out.content).toMatch(/^⚠️ /)
			expect(out.content).toContain('1 succeeded, 1 failed')
		})

		it('falls back to the workspace link when no success result carries an id', () => {
			const out = formatMutationConfirm(
				{ verb: 'mark_read', results: [{ success: true }] },
				baseCtx({ tool: 'mark_read' }),
			)
			expect(out.content).toContain(`https://maskin.app/r/${WS}?t=mark_read`)
		})

		it('routes to a settings sub-section when one is provided', () => {
			const out = formatMutationConfirm(
				{ verb: 'set_llm_api_key', results: [{ success: true }], section: 'keys' },
				baseCtx({ tool: 'set_llm_api_key' }),
			)
			expect(out.content).toContain('/settings/keys?t=set_llm_api_key')
		})
	})
})
