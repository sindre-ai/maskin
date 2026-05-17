import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCallTool, useToolResult, useWebAppContext } from '../shared/mcp-app-provider'
import { isArray, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { WebAppLink } from '../shared/web-app-link'

export const POPUP_MESSAGE_TYPE = 'maskin:oauth-return'
export const POPUP_FEATURES = 'width=600,height=720,menubar=no,toolbar=no'
export const OAUTH_RETURN_TIMEOUT_MS = 5 * 60 * 1000

export interface Integration {
	id: string
	provider: string
	status: string
	externalId?: string | null
}

export interface ProviderEvent {
	entityType: string
	actions: string[]
	label: string
}

export interface Provider {
	name: string
	displayName: string
	events: ProviderEvent[]
}

export function IntegrationsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) {
		return <div className="p-4 text-muted-foreground text-sm">No data received</div>
	}

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground whitespace-pre-wrap">{text}</div>
	const unwrapped = unwrapEnvelope(data)

	switch (toolResult.toolName) {
		case 'list_integrations':
			return isArray(unwrapped) ? (
				<IntegrationsListView initialIntegrations={unwrapped as Integration[]} />
			) : (
				<MessageView message={text} />
			)
		case 'list_integration_providers':
			return isArray(unwrapped) ? (
				<IntegrationsListView initialProviders={unwrapped as Provider[]} />
			) : (
				<MessageView message={text} />
			)
		case 'connect_integration':
			return <ConnectIntegrationView payload={data} />
		case 'disconnect_integration':
			return <DisconnectedView />
		default:
			return <MessageView message={text} />
	}
}

export function MessageView({ message }: { message: string }) {
	return <div className="p-4 text-sm text-foreground whitespace-pre-wrap">{message}</div>
}

export function IntegrationsListView({
	initialIntegrations,
	initialProviders,
}: {
	initialIntegrations?: Integration[]
	initialProviders?: Provider[]
}) {
	const callTool = useCallTool()
	const [integrations, setIntegrations] = useState<Integration[]>(initialIntegrations ?? [])
	const [providers, setProviders] = useState<Provider[]>(initialProviders ?? [])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const initialIntegrationsSeeded = initialIntegrations !== undefined
	const initialProvidersSeeded = initialProviders !== undefined

	useEffect(() => {
		// Whichever tool the agent first called only seeds half the data; fetch
		// the missing half so the card can show a unified provider list. Booleans
		// (not the array refs) gate the fetch so a parent re-render with new
		// array identities doesn't re-trigger the effect.
		let cancelled = false
		async function load() {
			setLoading(true)
			try {
				if (!initialIntegrationsSeeded) {
					const res = await callTool('list_integrations', {})
					const text = res.content?.find((c) => c.type === 'text')?.text
					const parsed = text ? safeParseJson(text) : null
					const unwrapped = unwrapEnvelope(parsed)
					if (!cancelled && isArray(unwrapped)) {
						setIntegrations(unwrapped as Integration[])
					}
				}
				if (!initialProvidersSeeded) {
					const res = await callTool('list_integration_providers', {})
					const text = res.content?.find((c) => c.type === 'text')?.text
					const parsed = text ? safeParseJson(text) : null
					const unwrapped = unwrapEnvelope(parsed)
					if (!cancelled && isArray(unwrapped)) {
						setProviders(unwrapped as Provider[])
					}
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err))
			} finally {
				if (!cancelled) setLoading(false)
			}
		}
		void load()
		return () => {
			cancelled = true
		}
	}, [callTool, initialIntegrationsSeeded, initialProvidersSeeded])

	const refresh = useCallback(async () => {
		const res = await callTool('list_integrations', {})
		const text = res.content?.find((c) => c.type === 'text')?.text
		const parsed = text ? safeParseJson(text) : null
		const unwrapped = unwrapEnvelope(parsed)
		if (isArray(unwrapped)) setIntegrations(unwrapped as Integration[])
	}, [callTool])

	const connectedByProvider = useMemo(() => {
		const map = new Map<string, Integration>()
		for (const i of integrations) {
			if (i.status === 'active') map.set(i.provider, i)
		}
		return map
	}, [integrations])

	const rows: Provider[] = providers.length
		? providers
		: integrations.map((i) => ({ name: i.provider, displayName: i.provider, events: [] }))

	if (!loading && rows.length === 0) {
		return (
			<EmptyState
				title="No providers available"
				description="No integration providers are configured on this server"
			/>
		)
	}

	return (
		<div className="p-4 max-w-2xl space-y-3">
			<div className="flex items-start justify-between gap-3">
				<h1 className="text-lg font-semibold text-foreground">Integrations</h1>
				<WebAppLink target={{ kind: 'settings', section: 'integrations' }} />
			</div>
			{error && (
				<div className="text-xs text-destructive border border-destructive/40 rounded-md p-2">
					{error}
				</div>
			)}
			<div className="space-y-2">
				{rows.map((p) => (
					<ProviderRow
						key={p.name}
						provider={p}
						integration={connectedByProvider.get(p.name)}
						onChanged={refresh}
					/>
				))}
			</div>
		</div>
	)
}

export function ProviderRow({
	provider,
	integration,
	onChanged,
}: {
	provider: Provider
	integration?: Integration
	onChanged: () => Promise<void>
}) {
	const callTool = useCallTool()
	const webAppCtx = useWebAppContext()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const popupRef = useRef<Window | null>(null)
	const abortRef = useRef<AbortController | null>(null)
	const isConnected = !!integration

	useEffect(() => {
		// On unmount: abort any pending OAuth wait and close a leftover popup so
		// listeners/intervals don't leak past the component's lifetime.
		return () => {
			abortRef.current?.abort()
			abortRef.current = null
			const popup = popupRef.current
			popupRef.current = null
			if (popup && !popup.closed) {
				try {
					popup.close()
				} catch {
					// noop — best-effort
				}
			}
		}
	}, [])

	const onConnect = useCallback(async () => {
		// Abort any prior in-flight wait (defensive — onConnect shouldn't be
		// re-entered while busy, but the button is briefly clickable between
		// state transitions).
		abortRef.current?.abort()
		const ctrl = new AbortController()
		abortRef.current = ctrl
		setBusy(true)
		setError(null)
		try {
			const res = await callTool('connect_integration', { provider: provider.name })
			const text = res.content?.find((c) => c.type === 'text')?.text
			if (isErrorResult(res)) {
				throw new Error(text ?? 'Connection failed.')
			}
			const installUrl = text ? extractInstallUrl(text) : null
			if (!installUrl) {
				// Surface the raw response so the user can debug — typically this
				// means an older MCP server returned a payload we don't recognize.
				throw new Error(
					text
						? `Could not find install URL in response:\n${text}`
						: 'Server did not return an install URL.',
				)
			}
			// Open the OAuth popup. The /oauth-return shim posts back when the
			// callback completes — the listener below picks it up and refreshes.
			const popup = window.open(installUrl, 'maskin-oauth', POPUP_FEATURES)
			if (!popup) {
				throw new Error(
					'Popup blocked. Allow popups for this page or open the URL printed in the tool response.',
				)
			}
			popupRef.current = popup

			const expectedOrigin = webAppCtx?.baseUrl ? safeOrigin(webAppCtx.baseUrl) : null
			const expectedWorkspaceId = webAppCtx?.workspaceId ?? null
			const result = await waitForOauthReturn({
				popup,
				expectedOrigin,
				expectedProvider: provider.name,
				expectedWorkspaceId,
				signal: ctrl.signal,
				timeoutMs: OAUTH_RETURN_TIMEOUT_MS,
			})
			if (ctrl.signal.aborted) return
			if (result.status === 'error') {
				throw new Error(`Connection failed${result.errorCode ? ` (${result.errorCode})` : ''}`)
			}
			if (result.status === 'closed') {
				if (result.errorCode === 'timeout') {
					throw new Error('OAuth timed out. Try again.')
				}
				// User dismissed the popup before completing OAuth — silent.
				return
			}
			await onChanged()
		} catch (err) {
			if (ctrl.signal.aborted) return
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			if (abortRef.current === ctrl) abortRef.current = null
			popupRef.current = null
			if (!ctrl.signal.aborted) setBusy(false)
		}
	}, [callTool, onChanged, provider.name, webAppCtx?.baseUrl, webAppCtx?.workspaceId])

	const onDisconnect = useCallback(async () => {
		if (!integration) return
		setBusy(true)
		setError(null)
		try {
			const res = await callTool('disconnect_integration', { id: integration.id })
			if (isErrorResult(res)) {
				const text = res.content?.find((c) => c.type === 'text')?.text
				throw new Error(text ?? 'Disconnect failed.')
			}
			await onChanged()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}, [callTool, integration, onChanged])

	return (
		<div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
			<div className="flex items-center gap-3">
				<div
					className={`h-3 w-3 rounded-full ${isConnected ? 'bg-success' : 'bg-muted-foreground'}`}
				/>
				<div className="flex-1">
					<p className="text-sm font-medium text-foreground">{provider.displayName}</p>
					<p className="text-xs text-muted-foreground">
						{isConnected
							? `Connected${integration.externalId ? ` · ${integration.externalId}` : ''}`
							: provider.events.length
								? `${provider.events.length} event types available`
								: 'Not connected'}
					</p>
				</div>
				{isConnected ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={onDisconnect}
						disabled={busy}
						className="text-muted-foreground hover:text-destructive"
					>
						Disconnect
					</Button>
				) : (
					<Button size="sm" onClick={onConnect} disabled={busy}>
						{busy ? 'Connecting…' : 'Connect'}
					</Button>
				)}
			</div>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	)
}

export function ConnectIntegrationView({ payload }: { payload: unknown }) {
	const url = isInstallUrlPayload(payload) ? payload.install_url : null
	return (
		<div className="p-4 max-w-md space-y-2">
			<p className="text-sm text-foreground">
				Open the install URL in your browser to complete the connection.
			</p>
			{url && (
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="text-sm text-accent hover:underline break-all"
				>
					{url}
				</a>
			)}
		</div>
	)
}

export function DisconnectedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Integration disconnected.</p>
		</div>
	)
}

export function isErrorResult(res: unknown): boolean {
	return typeof res === 'object' && res !== null && (res as { isError?: unknown }).isError === true
}

export function isInstallUrlPayload(data: unknown): data is { install_url: string } {
	return (
		typeof data === 'object' &&
		data !== null &&
		'install_url' in data &&
		typeof (data as { install_url: unknown }).install_url === 'string'
	)
}

/**
 * Extract an OAuth install URL from a tool response text. Tolerant of two
 * formats so the card keeps working across MCP server versions:
 *   1. Pure JSON `{"install_url":"..."}` — emitted by the current MCP server
 *   2. Prose with an embedded JSON block — emitted by older MCP servers
 *      ("Open this URL...\n\n<URL>\n\n{...}")
 */
export function extractInstallUrl(text: string): string | null {
	const direct = safeParseJson(text)
	if (isInstallUrlPayload(direct)) return direct.install_url
	// Fall back: find the first `{...}` block and try to parse it as JSON.
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start !== -1 && end > start) {
		const embedded = safeParseJson(text.slice(start, end + 1))
		if (isInstallUrlPayload(embedded)) return embedded.install_url
	}
	return null
}

export function safeOrigin(url: string): string | null {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

export interface OauthReturnMessage {
	type: string
	provider: string | null
	workspaceId: string | null
	status: 'success' | 'error' | null
	errorCode: string | null
}

export function isOauthReturnMessage(value: unknown): value is OauthReturnMessage {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	return v.type === POPUP_MESSAGE_TYPE
}

export interface WaitForOauthReturnArgs {
	popup: Window
	expectedOrigin: string | null
	expectedProvider: string
	expectedWorkspaceId: string | null
	signal?: AbortSignal
	timeoutMs?: number
}

/**
 * Listen for the postMessage from `/oauth-return`. Resolves to:
 *   - `success`/`error` when a valid message arrives
 *   - `closed` when the popup is dismissed, the wait is aborted, or the
 *     timeout elapses (`errorCode` distinguishes `timeout`/`aborted`)
 *
 * Trust model — the shim posts with target `'*'` because it can't know the
 * card's origin in advance, so this function MUST enforce all of:
 *   1. `event.origin === expectedOrigin` (fail closed if expectedOrigin is null)
 *   2. `event.source === popup` (drop messages from other windows)
 *   3. `event.data` matches the OauthReturnMessage shape
 *   4. `provider` and `workspaceId` match this card's context
 */
export function waitForOauthReturn({
	popup,
	expectedOrigin,
	expectedProvider,
	expectedWorkspaceId,
	signal,
	timeoutMs,
}: WaitForOauthReturnArgs): Promise<{
	status: 'success' | 'error' | 'closed'
	errorCode?: string | null
}> {
	return new Promise((resolve) => {
		let settled = false
		const onMessage = (event: MessageEvent) => {
			// Fail closed: without a known expected origin we can't safely trust
			// any message — drop them all and let the popup-close fallback fire.
			if (!expectedOrigin || event.origin !== expectedOrigin) return
			// Only trust the popup we opened — drops messages from other frames
			// or windows that happen to know the message type.
			if (event.source !== popup) return
			if (!isOauthReturnMessage(event.data)) return
			// Require exact match — a missing/null provider or workspaceId is
			// dropped rather than allowed through, so the trust-model checks
			// hold even if the shim ever omits these fields.
			if (event.data.provider !== expectedProvider) return
			if (expectedWorkspaceId !== null && event.data.workspaceId !== expectedWorkspaceId) return
			settle({
				status: event.data.status ?? 'success',
				errorCode: event.data.errorCode,
			})
		}
		const interval = window.setInterval(() => {
			if (popup.closed) settle({ status: 'closed' })
		}, 500)
		const timeoutId = timeoutMs
			? window.setTimeout(() => {
					closePopup()
					settle({ status: 'closed', errorCode: 'timeout' })
				}, timeoutMs)
			: 0
		const onAbort = () => {
			closePopup()
			settle({ status: 'closed', errorCode: 'aborted' })
		}
		const closePopup = () => {
			try {
				if (!popup.closed) popup.close()
			} catch {
				// noop — best-effort
			}
		}
		const cleanup = () => {
			window.removeEventListener('message', onMessage)
			window.clearInterval(interval)
			if (timeoutId) window.clearTimeout(timeoutId)
			signal?.removeEventListener('abort', onAbort)
		}
		const settle = (value: {
			status: 'success' | 'error' | 'closed'
			errorCode?: string | null
		}) => {
			if (settled) return
			settled = true
			cleanup()
			resolve(value)
		}
		if (signal?.aborted) {
			onAbort()
			return
		}
		signal?.addEventListener('abort', onAbort, { once: true })
		window.addEventListener('message', onMessage)
	})
}
