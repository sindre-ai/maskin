/**
 * A workspace-relative path that is safe to navigate to from a URL parameter.
 *
 * `return_to` arrives in the query string, so anyone can craft a link carrying
 * one. It is honoured only as a plain path inside the current workspace — never
 * an absolute URL, a protocol-relative `//host`, or a path into another
 * workspace. Mirrors `sanitizeReturnPath` in
 * apps/dev/src/lib/integrations/oauth/return-path.ts, which guards the same value
 * on the server before it ever reaches a redirect.
 */
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]+$/

export function safeReturnPath(raw: unknown, workspaceId: string): string | undefined {
	if (typeof raw !== 'string' || raw.length > 300) return undefined
	if (!SAFE_PATH.test(raw) || raw.includes('//') || raw.includes('..')) return undefined
	return raw.startsWith(`/${workspaceId}/`) ? raw : undefined
}
