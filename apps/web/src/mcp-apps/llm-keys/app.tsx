import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { WebAppLink } from '../shared/web-app-link'

type Provider = 'anthropic' | 'openai'
const PROVIDERS: Provider[] = ['anthropic', 'openai']
const PROVIDER_LABELS: Record<Provider, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
}

interface LlmKeysStatus {
	anthropic: { set: boolean; last4?: string }
	openai: { set: boolean; last4?: string }
}

function LlmKeysApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	const unwrapped = unwrapEnvelope(data)

	const initial = isObject<LlmKeysStatus>(unwrapped, 'anthropic', 'openai')
		? unwrapped
		: extractStatusFromMutation(data)

	if (!initial) {
		return <div className="p-4 text-sm text-foreground">{text}</div>
	}
	return <LlmKeysView initialStatus={initial} />
}

function extractStatusFromMutation(data: unknown): LlmKeysStatus | null {
	if (!isObject<{ provider?: string; success?: boolean; last4?: string }>(data)) return null
	if (typeof data.provider !== 'string') return null
	const status: LlmKeysStatus = {
		anthropic: { set: false },
		openai: { set: false },
	}
	if (data.provider === 'anthropic' || data.provider === 'openai') {
		status[data.provider] = data.last4 ? { set: true, last4: data.last4 } : { set: false }
	}
	return status
}

function LlmKeysView({ initialStatus }: { initialStatus: LlmKeysStatus }) {
	const callTool = useCallTool()
	const [status, setStatus] = useState<LlmKeysStatus>(initialStatus)
	const [provider, setProvider] = useState<Provider>('anthropic')
	const [apiKey, setApiKey] = useState('')
	const [busy, setBusy] = useState<Provider | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setStatus(initialStatus)
	}, [initialStatus])

	const refresh = async () => {
		try {
			const result = await callTool('get_llm_api_keys', {})
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			const parsed = text ? safeParseJson(text) : null
			const unwrapped = unwrapEnvelope(parsed)
			if (isObject<LlmKeysStatus>(unwrapped, 'anthropic', 'openai')) {
				setStatus(unwrapped)
			}
		} catch (err) {
			console.error('Failed to refresh LLM keys', err)
		}
	}

	const submit = async () => {
		if (!apiKey.trim()) {
			setError('API key is required')
			return
		}
		setBusy(provider)
		setError(null)
		try {
			await callTool('set_llm_api_key', { provider, api_key: apiKey })
			setApiKey('')
			await refresh()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	const remove = async (p: Provider) => {
		setBusy(p)
		setError(null)
		const previous = status
		setStatus((s) => ({ ...s, [p]: { set: false } }))
		try {
			await callTool('delete_llm_api_key', { provider: p })
		} catch (err) {
			setStatus(previous)
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	return (
		<div className="p-4 max-w-2xl space-y-4">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold text-foreground">LLM API Keys</h2>
				<WebAppLink target={{ kind: 'settings', section: 'keys' }} label="Open in Maskin" />
			</div>

			<div className="space-y-1">
				{PROVIDERS.map((p) => (
					<div
						key={p}
						className="flex items-center justify-between rounded-lg border border-border bg-bg-surface p-3"
					>
						<div>
							<div className="text-sm text-foreground">{PROVIDER_LABELS[p]}</div>
							<div className="text-xs text-muted-foreground">
								{status[p].set
									? `Configured · ending in ${status[p].last4 ?? '••••'}`
									: 'Not configured'}
							</div>
						</div>
						{status[p].set && (
							<Button
								size="sm"
								variant="ghost"
								disabled={busy === p}
								onClick={() => remove(p)}
								title="Remove key"
							>
								<Trash2 className="size-4" />
							</Button>
						)}
					</div>
				))}
			</div>

			<div className="rounded-lg border border-border bg-card p-3 space-y-2">
				<h3 className="text-sm font-medium text-foreground">Add or replace a key</h3>
				<div className="grid grid-cols-[180px_1fr] gap-2">
					<Select
						value={provider}
						onValueChange={(v) => setProvider(v as Provider)}
						disabled={busy !== null}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PROVIDERS.map((p) => (
								<SelectItem key={p} value={p}>
									{PROVIDER_LABELS[p]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						type="password"
						placeholder="API key"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						disabled={busy !== null}
					/>
				</div>
				{error && <p className="text-xs text-destructive">{error}</p>}
				<div className="flex justify-end">
					<Button size="sm" onClick={submit} disabled={busy !== null}>
						Save key
					</Button>
				</div>
			</div>
		</div>
	)
}

renderMcpApp('LlmKeys', <LlmKeysApp />)
