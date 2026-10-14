import { readFileSync } from 'node:fs'
import { classifyOAuthRoute } from '@maskin/auth'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * Drift guard for the mat_ route allowlist (packages/auth/src/oauth-route-allowlist.ts).
 *
 * The allowlist is "the routes the MCP tools call". This reads every REST call packages/mcp
 * makes and checks it against the real route table, so a tool that starts calling a refused
 * route (and would fail under a Claude connector token) shows up here as a failure that
 * someone has to acknowledge, instead of as a support ticket.
 *
 * It reads call sites out of the source text, so it covers calls written as
 * ('METHOD', '/api/path') in packages/mcp/src/server.ts. Extension tools under /api/m/ build
 * their path at runtime and are refused for mat_ tokens in v1.
 */

// Tools that call these routes answer a 403 under a Claude connector token in v1, on purpose.
const UNAVAILABLE_UNDER_OAUTH = [
	'DELETE /api/integrations/x', // disconnect_integration: third-party credentials
	'PATCH /api/workspaces/x', // update_workspace: workspace settings
	'POST /api/actors', // create_actor: returns a new API key
	'POST /api/integrations/x/connect', // connect_integration: third-party credentials
	'POST /api/workspaces', // create_workspace
	'POST /api/workspaces/x/members', // add_member: changes who is in a workspace
]

// Pre-existing: the MCP server calls a route the API does not register. Not part of this change.
const CALLS_TO_UNREGISTERED_ROUTES = ['GET /api/triggers/x']

function registeredApiRoutes(): string[] {
	const deps: AppDeps = {
		db: {} as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	const app = createApp(deps, { includeExtensions: false })
	return [
		...new Set(
			app.routes
				.filter((r) => r.path.startsWith('/api/') && !r.path.includes('*'))
				.map((r) => `${r.method} ${r.path}`),
		),
	]
}

/** '/api/files/${id}?x=1' becomes '/api/files/x'; a '${...}' suffix on a segment is a query string. */
function normalisePath(template: string): string {
	const out: string[] = []
	for (const segment of template.split('?')[0].split('/')) {
		if (segment.includes('${') && !segment.startsWith('${')) {
			out.push(segment.slice(0, segment.indexOf('${')))
			break
		}
		out.push(segment.startsWith('${') ? 'x' : segment)
	}
	return out.join('/')
}

function patternMatches(pattern: string, concrete: string): boolean {
	const a = pattern.split('/')
	const b = concrete.split('/')
	return (
		a.length === b.length && a.every((seg, i) => (seg.startsWith(':') ? b[i] !== '' : seg === b[i]))
	)
}

function mcpCalls(): string[] {
	const source = readFileSync(
		new URL('../../../../packages/mcp/src/server.ts', import.meta.url),
		'utf8',
	)
	const calls = new Set<string>()
	for (const m of source.matchAll(/'(GET|POST|PATCH|PUT|DELETE)',\s*[`'](\/api\/[^`']*)[`']/g)) {
		calls.add(`${m[1]} ${normalisePath(m[2])}`)
	}
	return [...calls].sort()
}

describe('MCP tool calls vs the mat_ route allowlist', () => {
	const routes = registeredApiRoutes()
	const calls = mcpCalls()

	function routesFor(call: string): string[] {
		const [method, path] = call.split(' ')
		return routes.filter((r) => {
			const [routeMethod, routePath] = r.split(' ')
			return routeMethod === method && patternMatches(routePath, path)
		})
	}

	it('finds the MCP call sites it is meant to guard', () => {
		expect(calls.length).toBeGreaterThan(50)
		expect(calls).toContain('GET /api/objects/x')
		expect(calls).toContain('POST /api/graph')
	})

	it('allows every route an MCP tool calls, except the ones that are unavailable on purpose', () => {
		const notAllowed = calls.filter((call) => {
			const hits = routesFor(call)
			if (hits.length === 0) return false
			return !hits.some((r) => {
				const [method, path] = r.split(' ')
				return classifyOAuthRoute(method, path) === 'allowed'
			})
		})
		expect(notAllowed).toEqual(UNAVAILABLE_UNDER_OAUTH)
	})

	it('knows which MCP calls have no registered route', () => {
		expect(calls.filter((call) => routesFor(call).length === 0)).toEqual(
			CALLS_TO_UNREGISTERED_ROUTES,
		)
	})
})
