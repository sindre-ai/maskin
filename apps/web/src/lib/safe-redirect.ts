/**
 * A path inside this app that is safe to send the browser to after login, or null. Only a single-slash path is
 * accepted: `//host`, `/\host` and full URLs would turn the login page into an open redirect.
 */
export function safeInternalPath(raw: unknown): string | null {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
	for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) < 32) return null
	return raw
}
