/**
 * Where to send the browser after an integration connect finishes.
 *
 * The connect flow normally ends on Settings → Integrations. A caller that
 * started the flow somewhere else — an agent's Connect card in a chat — passes
 * a `return_to` path so the user lands back where they clicked.
 *
 * The value is attacker-influenced input that ends up in a 302, so it is
 * accepted only as a plain path INSIDE the workspace being connected. Anything
 * else (an absolute URL, `//host`, a path into another workspace, traversal) is
 * dropped and the flow falls back to the settings page.
 */

const MAX_RETURN_PATH_LENGTH = 300
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]+$/

/** The path if it is safe to redirect to for this workspace, otherwise `undefined`. */
export function sanitizeReturnPath(raw: unknown, workspaceId: string): string | undefined {
	if (typeof raw !== 'string') return undefined
	if (raw.length > MAX_RETURN_PATH_LENGTH) return undefined
	if (!SAFE_PATH.test(raw)) return undefined
	if (raw.includes('//') || raw.includes('..')) return undefined
	if (!raw.startsWith(`/${workspaceId}/`)) return undefined
	return raw
}

/** Absolute frontend URL for `path` (or the workspace's settings page when absent). */
export function frontendUrlForReturn(workspaceId: string, returnTo?: string): string {
	const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
	return `${base}${returnTo ?? `/${workspaceId}/settings/integrations`}`
}
