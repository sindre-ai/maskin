import { getApiKey, getStoredActor } from './auth'
import { API_BASE } from './constants'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

// First-party UI analytics. The console line is kept for local development;
// the network call ships the same event to /api/analytics so bet KPIs (e.g.
// "≥1 menu_opened per active user per workday") can be answered by a DB query.
// The fetch is fire-and-forget: rejections must never break the UI.
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
		sendToServer(name, props, payload.ts)
	} catch {
		// Analytics must never break the UI.
	}
}

function sendToServer(name: string, props: AnalyticsProps, ts: string): void {
	const workspaceId = readWorkspaceIdFromUrl()
	if (!workspaceId) return
	const apiKey = getApiKey()
	if (!apiKey) return

	// Strip undefined values so they don't serialize as null and trip the
	// server-side schema. Booleans, numbers, strings, and explicit nulls pass through.
	const cleanProps: Record<string, string | number | boolean | null> = {}
	for (const [k, v] of Object.entries(props)) {
		if (v !== undefined) cleanProps[k] = v
	}

	try {
		void fetch(`${API_BASE}/analytics`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
				'X-Workspace-Id': workspaceId,
			},
			body: JSON.stringify({ name, props: cleanProps, ts }),
			keepalive: true,
		}).catch(() => {
			// Swallow rejections — analytics must never break the UI.
		})
	} catch {
		// Swallow synchronous errors too (e.g. fetch throws on aborted contexts).
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readWorkspaceIdFromUrl(): string | null {
	if (typeof window === 'undefined') return null
	const segments = window.location.pathname.split('/').filter(Boolean)
	const first = segments[0]
	return first && UUID_RE.test(first) ? first : null
}
