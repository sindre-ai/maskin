import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deepLink } from '../deep-link'

const WS = '11111111-1111-1111-1111-111111111111'
const OID = '22222222-2222-2222-2222-222222222222'
const AID = '33333333-3333-3333-3333-333333333333'
const TID = '44444444-4444-4444-4444-444444444444'

const ENV_KEYS = ['WEB_APP_URL', 'FRONTEND_URL'] as const

describe('deepLink', () => {
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

	describe('per-kind URL shapes', () => {
		it('workspace → /r/{ws}', () => {
			expect(deepLink({ workspaceId: WS, kind: 'workspace', tool: 'list_workspaces' })).toBe(
				`https://maskin.app/r/${WS}?t=list_workspaces`,
			)
		})

		it('object → /r/{ws}/objects/{id}', () => {
			expect(deepLink({ workspaceId: WS, kind: 'object', id: OID, tool: 'get_objects' })).toBe(
				`https://maskin.app/r/${WS}/objects/${OID}?t=get_objects`,
			)
		})

		it('comments → /r/{ws}/objects/{id} (same path as object, distinct tool name)', () => {
			expect(deepLink({ workspaceId: WS, kind: 'comments', id: OID, tool: 'get_comments' })).toBe(
				`https://maskin.app/r/${WS}/objects/${OID}?t=get_comments`,
			)
		})

		it('unread → /r/{ws}/activity', () => {
			expect(deepLink({ workspaceId: WS, kind: 'unread', tool: 'list_unread' })).toBe(
				`https://maskin.app/r/${WS}/activity?t=list_unread`,
			)
		})

		it('search → /r/{ws}/objects?q=…', () => {
			expect(
				deepLink({
					workspaceId: WS,
					kind: 'search',
					query: 'launch',
					tool: 'search_objects',
				}),
			).toBe(`https://maskin.app/r/${WS}/objects?q=launch&t=search_objects`)
		})

		it('search without a query → bare /objects (still classified as `search` by /r when q absent? — no, /r classifies as list; that is fine because the user has no query)', () => {
			// When no query is supplied we just land on the unfiltered list. The
			// /r classifier will call this `list` and not `search`, which is the
			// correct surface label.
			expect(deepLink({ workspaceId: WS, kind: 'search', tool: 'search_objects' })).toBe(
				`https://maskin.app/r/${WS}/objects?t=search_objects`,
			)
		})

		it('list with a type filter → /r/{ws}/objects?type=bet', () => {
			expect(deepLink({ workspaceId: WS, kind: 'list', type: 'bet', tool: 'list_objects' })).toBe(
				`https://maskin.app/r/${WS}/objects?type=bet&t=list_objects`,
			)
		})

		it('actor with id → /r/{ws}/agents/{id}', () => {
			expect(deepLink({ workspaceId: WS, kind: 'actor', id: AID, tool: 'list_actors' })).toBe(
				`https://maskin.app/r/${WS}/agents/${AID}?t=list_actors`,
			)
		})

		it('actor without id → /r/{ws}/agents (index)', () => {
			expect(deepLink({ workspaceId: WS, kind: 'actor', tool: 'list_actors' })).toBe(
				`https://maskin.app/r/${WS}/agents?t=list_actors`,
			)
		})

		it('trigger with id → /r/{ws}/triggers/{id}', () => {
			expect(deepLink({ workspaceId: WS, kind: 'trigger', id: TID, tool: 'list_triggers' })).toBe(
				`https://maskin.app/r/${WS}/triggers/${TID}?t=list_triggers`,
			)
		})

		it('trigger without id → /r/{ws}/triggers (index)', () => {
			expect(deepLink({ workspaceId: WS, kind: 'trigger', tool: 'list_triggers' })).toBe(
				`https://maskin.app/r/${WS}/triggers?t=list_triggers`,
			)
		})

		it('settings with section → /r/{ws}/settings/{section}', () => {
			expect(
				deepLink({
					workspaceId: WS,
					kind: 'settings',
					section: 'keys',
					tool: 'get_workspace_schema',
				}),
			).toBe(`https://maskin.app/r/${WS}/settings/keys?t=get_workspace_schema`)
		})

		it('settings without section → /r/{ws}/settings', () => {
			expect(deepLink({ workspaceId: WS, kind: 'settings', tool: 'get_workspace_schema' })).toBe(
				`https://maskin.app/r/${WS}/settings?t=get_workspace_schema`,
			)
		})
	})

	describe('sessionId and forwarded query params', () => {
		it('appends ?s={sessionId} alongside ?t={tool}', () => {
			expect(
				deepLink({
					workspaceId: WS,
					kind: 'object',
					id: OID,
					tool: 'get_objects',
					sessionId: 'sess-abc',
				}),
			).toBe(`https://maskin.app/r/${WS}/objects/${OID}?t=get_objects&s=sess-abc`)
		})

		it('omits ?s= when sessionId is not supplied', () => {
			const url = deepLink({ workspaceId: WS, kind: 'object', id: OID, tool: 'get_objects' })
			expect(url).not.toContain('s=')
		})

		it('URL-encodes the search query', () => {
			expect(
				deepLink({
					workspaceId: WS,
					kind: 'search',
					query: 'foo bar & baz',
					tool: 'search_objects',
				}),
			).toBe(`https://maskin.app/r/${WS}/objects?q=foo+bar+%26+baz&t=search_objects`)
		})
	})

	describe('base URL resolution', () => {
		it('defaults to https://maskin.app when no env var is set', () => {
			const url = deepLink({ workspaceId: WS, kind: 'workspace', tool: 'list_workspaces' })
			expect(url.startsWith('https://maskin.app/r/')).toBe(true)
		})

		it('reads WEB_APP_URL', () => {
			process.env.WEB_APP_URL = 'https://staging.maskin.app'
			const url = deepLink({ workspaceId: WS, kind: 'workspace', tool: 'list_workspaces' })
			expect(url.startsWith('https://staging.maskin.app/r/')).toBe(true)
		})

		it('falls back to FRONTEND_URL when WEB_APP_URL is absent', () => {
			process.env.FRONTEND_URL = 'http://localhost:5173'
			const url = deepLink({ workspaceId: WS, kind: 'workspace', tool: 'list_workspaces' })
			expect(url.startsWith('http://localhost:5173/r/')).toBe(true)
		})

		it('prefers WEB_APP_URL over FRONTEND_URL when both are set', () => {
			process.env.WEB_APP_URL = 'https://prod.maskin.app'
			process.env.FRONTEND_URL = 'http://localhost:5173'
			const url = deepLink({ workspaceId: WS, kind: 'workspace', tool: 'list_workspaces' })
			expect(url.startsWith('https://prod.maskin.app/r/')).toBe(true)
		})

		it('explicit baseUrl overrides both env vars', () => {
			process.env.WEB_APP_URL = 'https://staging.maskin.app'
			const url = deepLink({
				workspaceId: WS,
				kind: 'workspace',
				tool: 'list_workspaces',
				baseUrl: 'https://preview.maskin.app',
			})
			expect(url.startsWith('https://preview.maskin.app/r/')).toBe(true)
		})

		it('strips a trailing slash from baseUrl so the path is not double-slashed', () => {
			const url = deepLink({
				workspaceId: WS,
				kind: 'workspace',
				tool: 'list_workspaces',
				baseUrl: 'https://preview.maskin.app/',
			})
			expect(url).toBe(`https://preview.maskin.app/r/${WS}?t=list_workspaces`)
		})
	})

	describe('validation', () => {
		it('throws when workspaceId is not a UUID', () => {
			expect(() =>
				deepLink({ workspaceId: 'not-a-uuid', kind: 'workspace', tool: 'list_workspaces' }),
			).toThrow(/invalid workspaceId/)
		})

		it('throws when kind=object is missing id', () => {
			expect(() => deepLink({ workspaceId: WS, kind: 'object', tool: 'get_objects' })).toThrow(
				/kind='object' requires id/,
			)
		})

		it('throws when kind=comments is missing id', () => {
			expect(() => deepLink({ workspaceId: WS, kind: 'comments', tool: 'get_comments' })).toThrow(
				/kind='comments' requires id/,
			)
		})

		it('throws when tool is empty', () => {
			expect(() => deepLink({ workspaceId: WS, kind: 'workspace', tool: '' })).toThrow(
				/tool is required/,
			)
		})
	})

	describe('redirect-classifier alignment', () => {
		// Sanity: every URL the helper produces must land on a path the Task 1
		// redirect at /r/:workspaceId[/*] is willing to forward. The classifier
		// only requires a UUID workspace id and a known first segment; this
		// table-test guards against future drift.
		const cases: Array<{ name: string; url: string; expectsPath: RegExp }> = [
			{
				name: 'workspace',
				url: deepLink({ workspaceId: WS, kind: 'workspace', tool: 't' }),
				expectsPath: new RegExp(`^/r/${WS}(?:\\?|$)`),
			},
			{
				name: 'object',
				url: deepLink({ workspaceId: WS, kind: 'object', id: OID, tool: 't' }),
				expectsPath: new RegExp(`^/r/${WS}/objects/${OID}`),
			},
			{
				name: 'unread',
				url: deepLink({ workspaceId: WS, kind: 'unread', tool: 't' }),
				expectsPath: new RegExp(`^/r/${WS}/activity`),
			},
			{
				name: 'search',
				url: deepLink({ workspaceId: WS, kind: 'search', query: 'x', tool: 't' }),
				expectsPath: new RegExp(`^/r/${WS}/objects\\?q=x`),
			},
		]

		for (const { name, url, expectsPath } of cases) {
			it(`emits a /r-prefixed path the classifier recognises for ${name}`, () => {
				const parsed = new URL(url)
				expect(parsed.pathname + parsed.search).toMatch(expectsPath)
			})
		}
	})
})
