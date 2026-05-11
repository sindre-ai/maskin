import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

/**
 * Public OAuth return shim.
 *
 * The backend's `/api/integrations/:provider/callback` redirects here after
 * exchanging the authorization code. Two callers can land on this page:
 *
 *  1. **MCP card popup** (rich-app surface): the integrations card opened
 *     `install_url` in a popup. We post a message back to `window.opener`
 *     and close ourselves so the card can refresh its connection state
 *     without the user leaving Claude.
 *  2. **Web app full-page redirect** (existing flow from the settings
 *     page): there is no `window.opener`, so we bounce to
 *     `/{workspaceId}/settings/integrations` to preserve the prior UX.
 *
 * Pre-shared message contract — keep in sync with
 * `apps/web/src/mcp-apps/integrations/integrations-app.tsx`. The card
 * validates `event.origin` (must equal the web-app base URL),
 * `event.source` (must be the popup it opened), `provider`, and
 * `workspaceId` before acting on the message.
 */

interface OauthReturnSearch {
	provider?: string
	workspace_id?: string
	status?: 'success' | 'error'
	error_code?: string
}

export const POST_MESSAGE_TYPE = 'maskin:oauth-return'

export const Route = createFileRoute('/oauth-return')({
	component: OauthReturnPage,
	validateSearch: (search: Record<string, unknown>): OauthReturnSearch => ({
		provider: typeof search.provider === 'string' ? search.provider : undefined,
		workspace_id: typeof search.workspace_id === 'string' ? search.workspace_id : undefined,
		status: search.status === 'success' || search.status === 'error' ? search.status : undefined,
		error_code: typeof search.error_code === 'string' ? search.error_code : undefined,
	}),
})

function OauthReturnPage() {
	const search = Route.useSearch()
	const [fallback, setFallback] = useState(false)

	useEffect(() => {
		const opener = typeof window !== 'undefined' ? window.opener : null
		const isPopup = opener && opener !== window
		if (isPopup) {
			// We can't know the opener's origin a priori — MCP cards may be hosted
			// on the MCP host's sandbox origin (not this web app's origin), so
			// targeting `window.location.origin` would silently drop the message in
			// cross-origin setups. Use `'*'` and rely on the receiver to enforce
			// origin/source/workspace checks (see waitForOauthReturn in the
			// integrations card).
			const payload = {
				type: POST_MESSAGE_TYPE,
				provider: search.provider ?? null,
				workspaceId: search.workspace_id ?? null,
				status: search.status ?? null,
				errorCode: search.error_code ?? null,
			}
			try {
				opener.postMessage(payload, '*')
			} catch {
				// Hardened browsers may throw — fall through to close() so the card
				// can still detect completion via its popup-closed interval.
			}
			window.close()
			return
		}
		// Full-page redirect path (settings flow). Bounce after a beat so the
		// status flash is visible.
		if (search.workspace_id) {
			const params = new URLSearchParams()
			if (search.status) params.set('status', search.status)
			if (search.error_code) params.set('error', search.error_code)
			const qs = params.toString()
			window.location.replace(`/${search.workspace_id}/settings/integrations${qs ? `?${qs}` : ''}`)
			return
		}
		// No workspace context — surface a friendly message instead of a blank page.
		setFallback(true)
	}, [search.error_code, search.provider, search.status, search.workspace_id])

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="max-w-sm text-center space-y-2">
				<h1 className="text-base font-semibold text-foreground">
					{search.status === 'error' ? 'Connection failed' : 'Connection complete'}
				</h1>
				<p className="text-sm text-muted-foreground">
					{fallback
						? 'You can close this window.'
						: 'You can close this window — Maskin will pick up from here.'}
				</p>
				{search.error_code && <p className="text-xs text-destructive">{search.error_code}</p>}
			</div>
		</div>
	)
}
