import { OAUTH_ALLOWED_ROUTES, OAUTH_REFUSED_ROUTES, classifyOAuthRoute } from '@maskin/auth'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * A Claude connector token (mat_) fails closed: it reaches only the routes on an allowlist
 * in packages/auth. This walks the real route table and fails on any /api route that is
 * neither on that list nor refused on purpose, so adding a route fails CI until someone
 * decides whether a connected Claude client may call it.
 *
 * To fix a failure: add 'METHOD /route/pattern' to OAUTH_ALLOWED_ROUTES or
 * OAUTH_REFUSED_ROUTES in packages/auth/src/oauth-route-allowlist.ts. Allow it only if
 * every workspace_members query on the route is scoped to the token's pinned workspace.
 */

function buildApp() {
	const deps: AppDeps = {
		db: {} as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

type RouteTable = Array<{ method: string; path: string }>

/** Registered handler routes under /api. Wildcard entries are middleware, not routes. */
function apiRoutes(routes: RouteTable): string[] {
	const keys = new Set<string>()
	for (const { method, path } of routes) {
		if (!path.startsWith('/api/') || path.includes('*')) continue
		keys.add(`${method} ${path}`)
	}
	return [...keys].sort()
}

function unclassified(routes: RouteTable): string[] {
	return apiRoutes(routes).filter((key) => {
		const [method, path] = key.split(' ')
		return classifyOAuthRoute(method, path) === 'unclassified'
	})
}

describe('mat_ route allowlist vs the registered route table', () => {
	it('classifies every /api route as allowed or refused', () => {
		expect(unclassified(buildApp().routes)).toEqual([])
	})

	it('fails when a new route is added without being classified', () => {
		const app = buildApp()
		app.get('/api/temporary-unclassified-route', (c) => c.json({ ok: true }))
		app.post('/api/objects/:id/temporary-sub-route', (c) => c.json({ ok: true }))

		expect(unclassified(app.routes)).toEqual([
			'GET /api/temporary-unclassified-route',
			'POST /api/objects/:id/temporary-sub-route',
		])
	})

	it('has no stale entries: every listed route is still registered', () => {
		// A leftover allowlist entry would silently allow a future route that reuses the pattern.
		const registered = new Set(apiRoutes(buildApp().routes))
		const stale = [...OAUTH_ALLOWED_ROUTES, ...OAUTH_REFUSED_ROUTES].filter(
			(key) => !registered.has(key),
		)
		expect(stale).toEqual([])
	})

	it('allows only routes the MCP tools call: nothing that mints credentials or changes who is in a workspace', () => {
		const refused = [
			'POST /api/workspaces',
			'POST /api/actors',
			'POST /api/actors/:id/api-keys',
			'POST /api/workspaces/:id/members',
			'PATCH /api/workspaces/:id/members/:actorId',
			'DELETE /api/workspaces/:id/members/:actorId',
			'POST /api/workspaces/:id/transfer-ownership',
			'PATCH /api/workspaces/:id',
			'POST /api/claude-oauth/import',
			'POST /api/integrations/:provider/connect',
			'DELETE /api/integrations/:id',
			'GET /api/integrations/:id/github-token',
			// A connected Claude client must not approve its own access or manage connections.
			'GET /api/oauth/authorize/preview',
			'POST /api/oauth/authorize/approve',
			'POST /api/oauth/authorize/deny',
			'GET /api/oauth/grants',
			'DELETE /api/oauth/grants/:id',
		]
		for (const key of refused) {
			const [method, path] = key.split(' ')
			expect(classifyOAuthRoute(method, path), key).toBe('refused')
		}
	})
})
