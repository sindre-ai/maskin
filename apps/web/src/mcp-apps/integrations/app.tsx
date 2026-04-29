import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCallTool, useToolResult, useWebAppContext } from '../shared/mcp-app-provider'
import { isArray, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { WebAppLink } from '../shared/web-app-link'

const POPUP_MESSAGE_TYPE = 'maskin:oauth-return'
const POPUP_FEATURES = 'width=600,height=720,menubar=no,toolbar=no'

interface Integration {
	id: string
	provider: string
	status: string
	externalId?: string | null
}

interface ProviderEvent {
	entityType: string
	actions: string[]
	label: string
}

interface Provider {
	name: string
	displayName: string
	events: ProviderEvent[]
}

function IntegrationsApp() {
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

function MessageView({ message }: { message: string }) {
	return <div className="p-4 text-sm text-foreground whitespace-pre-wrap">{message}</div>
}

function IntegrationsListView({
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

	useEffect(() => {
		// Whichever tool the agent first called only seeds half the data; fetch
		// the missing half so the card can show a unified provider list.
		let cancelled = false
		async function load() {
			setLoading(true)
			try {
				if (initialIntegrations === undefined) {
					const res = await callTool('list_integrations', {})
					const text = res.content?.find((c) => c.type === 'text')?.text
					const parsed = text ? safeParseJson(text) : null
					const unwrapped = unwrapEnvelope(parsed)
					if (!cancelled && isArray(unwrapped)) {
						setIntegrations(unwrapped as Integration[])
					}
				}
				if (initialProviders === undefined) {
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
	}, [callTool, initialIntegrations, initialProviders])

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

function ProviderRow({
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
	const isConnected = !!integration

	const onConnect = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			const res = await callTool('connect_integration', { provider: provider.name })
			const text = res.content?.find((c) => c.type === 'text')?.text
			const data = text ? safeParseJson(text) : null
			const installUrl = isInstallUrlPayload(data) ? data.install_url : null
			if (!installUrl) {
				throw new Error('Server did not return an install URL.')
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
			const result = await waitForOauthReturn({
				popup,
				expectedOrigin,
				expectedProvider: provider.name,
			})
			if (result.status === 'error') {
				throw new Error(`Connection failed${result.errorCode ? ` (${result.errorCode})` : ''}`)
			}
			await onChanged()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}, [callTool, onChanged, provider.name, webAppCtx?.baseUrl])

	const onDisconnect = useCallback(async () => {
		if (!integration) return
		setBusy(true)
		setError(null)
		try {
			await callTool('disconnect_integration', { id: integration.id })
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

function ConnectIntegrationView({ payload }: { payload: unknown }) {
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

function DisconnectedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Integration disconnected.</p>
		</div>
	)
}

function isInstallUrlPayload(data: unknown): data is { install_url: string } {
	return (
		typeof data === 'object' &&
		data !== null &&
		'install_url' in data &&
		typeof (data as { install_url: unknown }).install_url === 'string'
	)
}

function safeOrigin(url: string): string | null {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

interface OauthReturnMessage {
	type: string
	provider: string | null
	workspaceId: string | null
	status: 'success' | 'error' | null
	errorCode: string | null
}

function isOauthReturnMessage(value: unknown): value is OauthReturnMessage {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	return v.type === POPUP_MESSAGE_TYPE
}

/**
 * Listen for the postMessage from `/oauth-return` (or detect popup close as a
 * fallback). Resolves to the parsed status, or `closed` if the user dismissed
 * the popup before completing OAuth.
 */
function waitForOauthReturn({
	popup,
	expectedOrigin,
	expectedProvider,
}: {
	popup: Window
	expectedOrigin: string | null
	expectedProvider: string
}): Promise<{ status: 'success' | 'error' | 'closed'; errorCode?: string | null }> {
	return new Promise((resolve) => {
		const onMessage = (event: MessageEvent) => {
			if (expectedOrigin && event.origin !== expectedOrigin) return
			if (!isOauthReturnMessage(event.data)) return
			if (event.data.provider && event.data.provider !== expectedProvider) return
			cleanup()
			resolve({
				status: event.data.status ?? 'success',
				errorCode: event.data.errorCode,
			})
		}
		const interval = window.setInterval(() => {
			if (popup.closed) {
				cleanup()
				resolve({ status: 'closed' })
			}
		}, 500)
		const cleanup = () => {
			window.removeEventListener('message', onMessage)
			window.clearInterval(interval)
		}
		window.addEventListener('message', onMessage)
	})
}

renderMcpApp('Integrations', <IntegrationsApp />)
