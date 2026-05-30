import { getApiKey, getStoredActor } from './auth'
import { API_BASE } from './constants'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

// First path segment of an authed URL is the workspace UUID — we read it here
// so call-sites stay unchanged. Returns null on login/signup/landing where
// there is no workspace context yet.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getWorkspaceIdFromUrl(): string | null {
	if (typeof window === 'undefined') return null
	const first = window.location.pathname.split('/').filter(Boolean)[0]
	return first && UUID_RE.test(first) ? first : null
}

export function trackEvent(name: string, props: AnalyticsProps = {}): void {
	try {
		const actor = getStoredActor()
		const payload = {
			ts: new Date().toISOString(),
			name,
			actorId: actor?.id ?? null,
			...props,
		}
		console.info('[analytics]', payload)

		const workspaceId = getWorkspaceIdFromUrl()
		const apiKey = getApiKey()
		if (!workspaceId || !apiKey) return

		// Drop undefined values so the server-side Zod schema accepts the payload.
		const cleanProps: Record<string, string | number | boolean | null> = {}
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined) cleanProps[k] = v
		}

		void fetch(`${API_BASE}/analytics`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'X-Workspace-Id': workspaceId,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name, props: cleanProps, ts: payload.ts }),
			keepalive: true,
		}).catch(() => {
			// Analytics must never break the UI.
		})
	} catch {
		// Analytics must never break the UI.
	}
}
