import { describe, expect, it } from 'vitest'
import {
	DEFAULT_WEB_APP_BASE_URL,
	WEB_APP_OBJECT_TYPES,
	type WebAppTarget,
	buildWebAppHref,
	buildWebAppPath,
	resolveWebAppBaseUrl,
	stripTrailingSlash,
} from '../web-app-urls'

const ws = 'ws-123'

describe('stripTrailingSlash', () => {
	it('removes exactly one trailing slash when present', () => {
		expect(stripTrailingSlash('https://maskin.io/')).toBe('https://maskin.io')
	})

	it('returns the input unchanged when there is no trailing slash', () => {
		expect(stripTrailingSlash('https://maskin.io')).toBe('https://maskin.io')
	})

	it('preserves the empty string', () => {
		expect(stripTrailingSlash('')).toBe('')
	})

	it('strips only a single slash so callers can detect over-trimmed input themselves', () => {
		expect(stripTrailingSlash('https://maskin.io//')).toBe('https://maskin.io/')
	})
})

describe('WEB_APP_OBJECT_TYPES', () => {
	it('covers every object-table type currently exposed by MCP', () => {
		// The contract row count drives F2's "one URL pattern per object type"
		// guarantee. If you add or remove an entry, update the table in the
		// docstring of `web-app-urls.ts` to match.
		expect(WEB_APP_OBJECT_TYPES).toEqual([
			'insight',
			'bet',
			'task',
			'meeting',
			'document',
			'decision',
			'risk',
			'metric',
			'canvas',
			'organization',
			'person',
		])
	})
})

describe('buildWebAppPath', () => {
	it('builds workspace root for workspace and pulse', () => {
		expect(buildWebAppPath(ws, { kind: 'workspace' })).toBe('/ws-123')
		expect(buildWebAppPath(ws, { kind: 'pulse' })).toBe('/ws-123')
	})

	it('builds object detail path for any objects-table type', () => {
		expect(buildWebAppPath(ws, { kind: 'object', id: 'obj-9' })).toBe('/ws-123/objects/obj-9')
		// `type` is informational only — the URL shape is identical for every
		// object-table type. This guarantees stable links even if a card mis-tags.
		for (const type of WEB_APP_OBJECT_TYPES) {
			expect(buildWebAppPath(ws, { kind: 'object', id: 'obj-1', type })).toBe(
				'/ws-123/objects/obj-1',
			)
		}
	})

	it('builds workspace objects list path with optional type filter', () => {
		expect(buildWebAppPath(ws, { kind: 'objects' })).toBe('/ws-123/objects')
		expect(buildWebAppPath(ws, { kind: 'objects', type: 'bet' })).toBe('/ws-123/objects?type=bet')
	})

	it('builds actor list and detail paths', () => {
		expect(buildWebAppPath(ws, { kind: 'actor' })).toBe('/ws-123/agents')
		expect(buildWebAppPath(ws, { kind: 'actor', id: 'a-1' })).toBe('/ws-123/agents/a-1')
	})

	it('treats actor and agent as aliases that produce the same URL', () => {
		expect(buildWebAppPath(ws, { kind: 'agent', id: 'a-1' })).toBe(
			buildWebAppPath(ws, { kind: 'actor', id: 'a-1' }),
		)
		expect(buildWebAppPath(ws, { kind: 'agent' })).toBe(buildWebAppPath(ws, { kind: 'actor' }))
	})

	it('builds trigger list and detail paths', () => {
		expect(buildWebAppPath(ws, { kind: 'trigger' })).toBe('/ws-123/triggers')
		expect(buildWebAppPath(ws, { kind: 'trigger', id: 't-1' })).toBe('/ws-123/triggers/t-1')
	})

	it('routes session links to the actor that ran them, falling back to the agents list', () => {
		expect(buildWebAppPath(ws, { kind: 'session', id: 'sess-1', actorId: 'a-1' })).toBe(
			'/ws-123/agents/a-1',
		)
		expect(buildWebAppPath(ws, { kind: 'session', id: 'sess-1' })).toBe('/ws-123/agents')
	})

	it('routes notification links to the pulse dashboard (no detail page yet)', () => {
		expect(buildWebAppPath(ws, { kind: 'notification' })).toBe('/ws-123')
		expect(buildWebAppPath(ws, { kind: 'notification', id: 'n-1' })).toBe('/ws-123')
	})

	it('routes extension links to settings (no detail page yet)', () => {
		expect(buildWebAppPath(ws, { kind: 'extension' })).toBe('/ws-123/settings')
		expect(buildWebAppPath(ws, { kind: 'extension', id: 'notetaker' })).toBe('/ws-123/settings')
	})

	it('routes relationship links to the source object detail page', () => {
		expect(buildWebAppPath(ws, { kind: 'relationship', sourceId: 'obj-a' })).toBe(
			'/ws-123/objects/obj-a',
		)
		expect(
			buildWebAppPath(ws, {
				kind: 'relationship',
				sourceId: 'obj-a',
				targetId: 'obj-b',
				type: 'blocks',
			}),
		).toBe('/ws-123/objects/obj-a')
	})

	it('builds file detail path from the id', () => {
		expect(buildWebAppPath(ws, { kind: 'file', id: 'file-1' })).toBe('/ws-123/files/file-1')
	})

	it('routes skill links to the settings skills list (no per-skill detail route yet)', () => {
		expect(buildWebAppPath(ws, { kind: 'skill', name: 'my-skill' })).toBe('/ws-123/settings/skills')
		// `name` is recorded on the target for forward-compat but ignored by the
		// current URL builder — every skill resolves to the shared settings list.
		expect(buildWebAppPath(ws, { kind: 'skill', name: 'other-skill' })).toBe(
			'/ws-123/settings/skills',
		)
	})

	it('builds loop list and detail paths', () => {
		expect(buildWebAppPath(ws, { kind: 'loop' })).toBe('/ws-123/loops')
		expect(buildWebAppPath(ws, { kind: 'loop', id: 'loop-1' })).toBe('/ws-123/loops/loop-1')
	})

	it('builds settings index and section paths', () => {
		expect(buildWebAppPath(ws, { kind: 'settings' })).toBe('/ws-123/settings')
		const sections = ['integrations', 'keys', 'mcp', 'members', 'skills', 'objects'] as const
		for (const section of sections) {
			expect(buildWebAppPath(ws, { kind: 'settings', section })).toBe(`/ws-123/settings/${section}`)
		}
	})

	it('produces a leading-slash path for every kind', () => {
		const targets: WebAppTarget[] = [
			{ kind: 'workspace' },
			{ kind: 'pulse' },
			{ kind: 'object', id: 'x' },
			{ kind: 'actor', id: 'x' },
			{ kind: 'agent', id: 'x' },
			{ kind: 'trigger', id: 'x' },
			{ kind: 'session', id: 'x', actorId: 'a' },
			{ kind: 'notification', id: 'x' },
			{ kind: 'extension', id: 'x' },
			{ kind: 'relationship', sourceId: 'x' },
			{ kind: 'file', id: 'x' },
			{ kind: 'skill', name: 'x' },
			{ kind: 'loop', id: 'x' },
			{ kind: 'settings' },
		]
		for (const t of targets) {
			expect(buildWebAppPath(ws, t).startsWith('/')).toBe(true)
		}
	})
})

describe('buildWebAppHref', () => {
	it('joins base URL and path verbatim (no re-normalisation)', () => {
		expect(buildWebAppHref('https://maskin.example.com', ws, { kind: 'pulse' })).toBe(
			'https://maskin.example.com/ws-123',
		)
		expect(buildWebAppHref('https://maskin.example.com', ws, { kind: 'object', id: 'o-1' })).toBe(
			'https://maskin.example.com/ws-123/objects/o-1',
		)
	})

	it('does not strip trailing slashes — that is the server `meta()` helper job', () => {
		// If a caller passes a trailing-slash baseUrl directly (skipping the
		// server normalisation), the resulting href has a double slash. This is
		// deliberate: callers must use the server-supplied `_meta.webAppBaseUrl`
		// which is already normalised. Asserting the behaviour pins the contract.
		expect(buildWebAppHref('https://maskin.example.com/', ws, { kind: 'pulse' })).toBe(
			'https://maskin.example.com//ws-123',
		)
	})
})

describe('resolveWebAppBaseUrl', () => {
	it('falls back to the production host when no env vars are set', () => {
		expect(resolveWebAppBaseUrl({})).toBe('https://maskin.io')
		expect(DEFAULT_WEB_APP_BASE_URL).toBe('https://maskin.io')
	})

	it('produces the workspace-scoped object URL when joined with the path builder', () => {
		// This is the contract the bug report cares about: the helper must yield
		// `https://maskin.io/<workspaceId>/objects/<id>` by default,
		// not `https://app.maskin.ai/objects/<id>`.
		const base = resolveWebAppBaseUrl({})
		expect(buildWebAppHref(base, ws, { kind: 'object', id: 'obj-1' })).toBe(
			'https://maskin.io/ws-123/objects/obj-1',
		)
	})

	it('prefers WEB_APP_URL over FRONTEND_URL and the default', () => {
		expect(
			resolveWebAppBaseUrl({
				WEB_APP_URL: 'https://override.example.com',
				FRONTEND_URL: 'https://other.example.com',
			}),
		).toBe('https://override.example.com')
	})

	it('falls back to FRONTEND_URL when WEB_APP_URL is unset', () => {
		expect(resolveWebAppBaseUrl({ FRONTEND_URL: 'https://other.example.com' })).toBe(
			'https://other.example.com',
		)
	})

	it('strips a single trailing slash so callers can append paths directly', () => {
		expect(resolveWebAppBaseUrl({ WEB_APP_URL: 'https://override.example.com/' })).toBe(
			'https://override.example.com',
		)
	})

	it('treats empty strings as unset', () => {
		// An env injection that produces `WEB_APP_URL=""` shouldn't silently
		// shadow the FRONTEND_URL fallback or the production default.
		expect(resolveWebAppBaseUrl({ WEB_APP_URL: '', FRONTEND_URL: '' })).toBe('https://maskin.io')
		expect(
			resolveWebAppBaseUrl({ WEB_APP_URL: '', FRONTEND_URL: 'https://other.example.com' }),
		).toBe('https://other.example.com')
	})

	it('accepts undefined env values', () => {
		expect(resolveWebAppBaseUrl({ WEB_APP_URL: undefined, FRONTEND_URL: undefined })).toBe(
			'https://maskin.io',
		)
	})
})
