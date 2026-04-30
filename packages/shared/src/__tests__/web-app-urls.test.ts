import { describe, expect, it } from 'vitest'
import {
	WEB_APP_OBJECT_TYPES,
	type WebAppTarget,
	buildWebAppHref,
	buildWebAppPath,
} from '../web-app-urls'

const ws = 'ws-123'

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

	it('builds activity feed path', () => {
		expect(buildWebAppPath(ws, { kind: 'activity' })).toBe('/ws-123/activity')
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

	it('routes session links to the actor that ran them, falling back to activity', () => {
		expect(buildWebAppPath(ws, { kind: 'session', id: 'sess-1', actorId: 'a-1' })).toBe(
			'/ws-123/agents/a-1',
		)
		expect(buildWebAppPath(ws, { kind: 'session', id: 'sess-1' })).toBe('/ws-123/activity')
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
			{ kind: 'activity' },
			{ kind: 'object', id: 'x' },
			{ kind: 'actor', id: 'x' },
			{ kind: 'agent', id: 'x' },
			{ kind: 'trigger', id: 'x' },
			{ kind: 'session', id: 'x', actorId: 'a' },
			{ kind: 'notification', id: 'x' },
			{ kind: 'extension', id: 'x' },
			{ kind: 'relationship', sourceId: 'x' },
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
