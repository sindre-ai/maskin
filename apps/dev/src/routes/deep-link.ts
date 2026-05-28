import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { mcpTelemetry } from '@maskin/db/schema'
import type { Context } from 'hono'
import { logger } from '../lib/logger'

type Env = {
	Variables: {
		db: Database
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Canonical kinds for click logging. Stay aligned with the WebAppTarget union
// in @maskin/shared/web-app-urls so analytics can join on tool deep links and
// app navigation without translation.
type DeepLinkKind =
	| 'workspace'
	| 'object'
	| 'list'
	| 'search'
	| 'activity'
	| 'actor'
	| 'trigger'
	| 'settings'
	| 'unknown'

/**
 * Classify a forwarded app path into a coarse kind so the click log can answer
 * "what surface are MCP users actually landing on?" without parsing paths
 * downstream. Mirrors WebAppTarget where possible; adds `list` and `search`
 * for the two filter modes on /objects that MCP tools surface today.
 */
function classifyPath(
	appPath: string,
	search: URLSearchParams,
): { kind: DeepLinkKind; targetId: string | null } {
	if (appPath === '' || appPath === '/') return { kind: 'workspace', targetId: null }

	const segments = appPath.replace(/^\/+/, '').split('/')
	const [head, second] = segments

	if (head === 'objects') {
		if (second && UUID_RE.test(second)) return { kind: 'object', targetId: second }
		if (search.has('q')) return { kind: 'search', targetId: null }
		return { kind: 'list', targetId: null }
	}
	if (head === 'activity') return { kind: 'activity', targetId: null }
	if (head === 'agents') return { kind: 'actor', targetId: second ?? null }
	if (head === 'triggers') return { kind: 'trigger', targetId: second ?? null }
	if (head === 'settings') return { kind: 'settings', targetId: second ?? null }
	return { kind: 'unknown', targetId: null }
}

const app = new OpenAPIHono<Env>()

/**
 * Workspace home redirect: `/r/:workspaceId` → `/:workspaceId`.
 *
 * Split from the wildcard handler below because Hono treats `/:workspaceId/*`
 * as requiring at least one path segment after the workspace id.
 */
app.get('/:workspaceId', async (c) => handleRedirect(c, ''))

/**
 * Catch-all redirect: `/r/:workspaceId/<rest>` → `/:workspaceId/<rest>`.
 *
 * The path after `:workspaceId` is forwarded verbatim to the SPA so the URL
 * contract stays single-source-of-truth (see `@maskin/shared/web-app-urls`).
 * This handler only adds click logging on top of that 302.
 */
app.get('/:workspaceId/*', async (c) => {
	const workspaceId = c.req.param('workspaceId')
	// Hono's `*` does not expose the matched suffix as a param, so derive it
	// from the request URL. `c.req.path` includes the mount prefix (`/r`).
	const fullPath = c.req.path
	const prefix = `/r/${workspaceId}/`
	const rest = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : ''
	return handleRedirect(c, rest)
})

async function handleRedirect(c: Context<Env>, rest: string) {
	const workspaceId = c.req.param('workspaceId') ?? ''
	if (!UUID_RE.test(workspaceId)) {
		return c.text('Invalid workspace id', 400)
	}

	const url = new URL(c.req.url)
	const search = url.searchParams
	// Strip telemetry-only params from the forwarded query so the SPA URL
	// stays clean. Everything else (e.g. `?q=`, `?type=`) is forwarded.
	const tool = search.get('t') ?? 'unknown'
	const sessionId = search.get('s')
	search.delete('t')
	search.delete('s')

	const appPath = rest ? `/${rest}` : ''
	const { kind, targetId } = classifyPath(appPath, search)

	const forwardedQuery = search.toString()
	const target = `/${workspaceId}${appPath}${forwardedQuery ? `?${forwardedQuery}` : ''}`

	// Best-effort logging — never block the redirect on the insert. If the
	// DB write fails the click is dropped and the user still lands on the
	// right page, which is the priority for this surface.
	const db = c.get('db')
	try {
		await db.insert(mcpTelemetry).values({
			workspaceId,
			eventType: 'deep_link_click',
			toolName: tool,
			sessionId,
			data: { kind, targetId, target },
		})
		logger.info('deep_link_click', { workspaceId, tool, kind, targetId, sessionId })
	} catch (err) {
		logger.error('Failed to log deep link click', {
			workspaceId,
			tool,
			kind,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	return c.redirect(target, 302)
}

export default app
