import { AgentCard } from '@/components/agents/agent-card'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import { Pencil } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ContentFold } from '../shared/content-fold'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { ActorResponse, ActorWithKey, SessionResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

function ActorsApp() {
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

	switch (toolResult.toolName) {
		case 'list_actors':
			return isArray(unwrapped) ? (
				<ActorListView actors={unwrapped as ActorResponse[]} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'create_actor':
			return isObject<ActorWithKey>(data, 'id', 'name') ? (
				<ActorCreatedView actor={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'get_actor':
		case 'update_actor':
			return isObject<ActorResponse>(data, 'id', 'name') ? (
				<ActorDetailView actor={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'regenerate_api_key': {
			const apiKey = isObject<{ api_key?: string }>(data) ? (data.api_key ?? '') : ''
			return <RegeneratedApiKeyView apiKey={apiKey} />
		}
		default:
			return isObject<ActorResponse>(data, 'id', 'name') ? (
				<ActorDetailView actor={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
	}
}

function ActorListView({ actors }: { actors: ActorResponse[] }) {
	const callTool = useCallTool()
	const callToolRef = useRef(callTool)
	callToolRef.current = callTool
	const [sessions, setSessions] = useState<SessionResponse[]>([])

	const agents = actors.filter((a) => a.type === 'agent')
	const humans = actors.filter((a) => a.type !== 'agent')

	useEffect(() => {
		if (!agents.length) return
		callToolRef.current('list_sessions', { limit: 100 }).then((result) => {
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			if (text) setSessions(JSON.parse(text))
		})
	}, [agents.length])

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions), [sessions])

	if (!actors.length) {
		return <EmptyState title="No actors" description="No actors found in this workspace" />
	}

	return (
		<div className="p-4 space-y-4">
			{agents.length > 0 && (
				<div className="space-y-2">
					{agents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							status={deriveAgentStatus(agent.id, sessionsByAgent)}
							latestSession={getLatestSession(agent.id, sessionsByAgent)}
						/>
					))}
				</div>
			)}
			{humans.length > 0 && (
				<div className="space-y-1">
					{humans.map((actor) => (
						<div
							key={actor.id}
							className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors"
						>
							<ActorAvatar name={actor.name} type={actor.type} size="sm" />
							<div className="flex-1 min-w-0">
								<span className="text-sm text-foreground">{actor.name}</span>
								{actor.email && (
									<span className="text-xs text-muted-foreground ml-2">{actor.email}</span>
								)}
							</div>
							<span className="text-xs text-muted-foreground capitalize">{actor.type}</span>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

function ActorDetailView({ actor }: { actor: ActorResponse }) {
	const isAgent = actor.type === 'agent'
	const [current, setCurrent] = useState<ActorResponse>(actor)
	const [editing, setEditing] = useState(false)

	useEffect(() => {
		setCurrent(actor)
	}, [actor])

	if (editing) {
		return (
			<ActorEditForm
				actor={current}
				onSaved={(next) => {
					setCurrent(next)
					setEditing(false)
				}}
				onCancel={() => setEditing(false)}
			/>
		)
	}

	return (
		<div className="p-4 max-w-2xl">
			<div className="flex items-start justify-between mb-4">
				<div className="flex items-center gap-3">
					<ActorAvatar name={current.name} type={current.type} />
					<div>
						<h1 className="text-lg font-semibold text-foreground">{current.name}</h1>
						<span className="text-xs text-muted-foreground capitalize">{current.type}</span>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{isAgent && (
						<WebAppLink target={{ kind: 'agent', id: current.id }} label="Open in Maskin" />
					)}
					<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
						<Pencil className="size-4 mr-1" /> Edit
					</Button>
				</div>
			</div>
			{current.email && (
				<div className="text-sm text-muted-foreground mb-2">
					<span className="text-muted-foreground">Email:</span> {current.email}
				</div>
			)}
			{current.systemPrompt && (
				<div className="border-t border-border pt-3 mt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						System Prompt
					</h3>
					<ContentFold
						lineCount={current.systemPrompt.split('\n').length}
						byteCount={`${(new TextEncoder().encode(current.systemPrompt).length / 1024).toFixed(1)}KB`}
					>
						<p className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
							{current.systemPrompt}
						</p>
					</ContentFold>
				</div>
			)}
			{current.llmProvider && (
				<div className="text-sm text-muted-foreground mt-2">
					<span className="text-muted-foreground">LLM:</span> {current.llmProvider}
					{current.llmConfig?.model ? ` / ${String(current.llmConfig.model)}` : null}
				</div>
			)}
		</div>
	)
}

function ActorEditForm({
	actor,
	onSaved,
	onCancel,
}: {
	actor: ActorResponse
	onSaved: (next: ActorResponse) => void
	onCancel: () => void
}) {
	const callTool = useCallTool()
	const isAgent = actor.type === 'agent'
	const [name, setName] = useState(actor.name)
	const [email, setEmail] = useState(actor.email ?? '')
	const [systemPrompt, setSystemPrompt] = useState(actor.systemPrompt ?? '')
	const [llmProvider, setLlmProvider] = useState(actor.llmProvider ?? '')
	const [llmModel, setLlmModel] = useState(
		typeof actor.llmConfig?.model === 'string' ? (actor.llmConfig.model as string) : '',
	)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = useCallback(async () => {
		setBusy(true)
		setError(null)
		const body: Record<string, unknown> = { id: actor.id }
		if (name !== actor.name) body.name = name
		if (email !== (actor.email ?? '')) body.email = email || undefined
		if (isAgent) {
			if (systemPrompt !== (actor.systemPrompt ?? '')) body.system_prompt = systemPrompt
			if (llmProvider !== (actor.llmProvider ?? '')) body.llm_provider = llmProvider || undefined
			const previousModel =
				typeof actor.llmConfig?.model === 'string' ? (actor.llmConfig.model as string) : ''
			if (llmModel !== previousModel) {
				body.llm_config = { ...(actor.llmConfig ?? {}), model: llmModel || undefined }
			}
		}
		try {
			const result = await callTool('update_actor', body)
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			const parsed = text ? safeParseJson(text) : null
			if (isObject<ActorResponse>(parsed, 'id', 'name')) {
				onSaved(parsed)
			} else {
				onSaved({
					...actor,
					name,
					email: email || null,
					systemPrompt: systemPrompt || null,
					llmProvider: llmProvider || null,
					llmConfig: { ...(actor.llmConfig ?? {}), model: llmModel || undefined },
				})
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}, [actor, callTool, email, isAgent, llmModel, llmProvider, name, onSaved, systemPrompt])

	return (
		<div className="p-4 max-w-2xl space-y-3">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold text-foreground">Edit {actor.type}</h2>
				<WebAppLink target={{ kind: 'agent', id: actor.id }} label="Open in Maskin" />
			</div>
			<div className="space-y-2">
				<label className="text-xs font-medium text-muted-foreground" htmlFor={`name-${actor.id}`}>
					Name
				</label>
				<Input
					id={`name-${actor.id}`}
					value={name}
					onChange={(e) => setName(e.target.value)}
					disabled={busy}
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs font-medium text-muted-foreground" htmlFor={`email-${actor.id}`}>
					Email
				</label>
				<Input
					id={`email-${actor.id}`}
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					disabled={busy}
				/>
			</div>
			{isAgent && (
				<>
					<div className="space-y-2">
						<label
							className="text-xs font-medium text-muted-foreground"
							htmlFor={`prompt-${actor.id}`}
						>
							System prompt
						</label>
						<Textarea
							id={`prompt-${actor.id}`}
							rows={6}
							value={systemPrompt}
							onChange={(e) => setSystemPrompt(e.target.value)}
							disabled={busy}
						/>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<div className="space-y-2">
							<label
								className="text-xs font-medium text-muted-foreground"
								htmlFor={`provider-${actor.id}`}
							>
								LLM provider
							</label>
							<Select
								value={llmProvider || 'unset'}
								onValueChange={(v) => setLlmProvider(v === 'unset' ? '' : v)}
								disabled={busy}
							>
								<SelectTrigger id={`provider-${actor.id}`}>
									<SelectValue placeholder="Select provider" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="unset">— None —</SelectItem>
									<SelectItem value="anthropic">Anthropic</SelectItem>
									<SelectItem value="openai">OpenAI</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<label
								className="text-xs font-medium text-muted-foreground"
								htmlFor={`model-${actor.id}`}
							>
								Model
							</label>
							<Input
								id={`model-${actor.id}`}
								value={llmModel}
								onChange={(e) => setLlmModel(e.target.value)}
								placeholder="e.g. claude-sonnet-4-6"
								disabled={busy}
							/>
						</div>
					</div>
				</>
			)}
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex justify-end gap-2 pt-2">
				<Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
				<Button size="sm" onClick={submit} disabled={busy}>
					Save
				</Button>
			</div>
		</div>
	)
}

function ActorCreatedView({ actor }: { actor: ActorWithKey }) {
	return (
		<div className="p-4 max-w-2xl">
			<h2 className="text-lg font-semibold text-foreground mb-2">Actor Created</h2>
			<div className="flex items-center gap-3 mb-4">
				<ActorAvatar name={actor.name} type={actor.type} />
				<div>
					<span className="text-sm text-foreground">{actor.name}</span>
					<span className="text-xs text-muted-foreground capitalize ml-2">{actor.type}</span>
				</div>
			</div>
			{actor.api_key && (
				<div className="rounded border border-border bg-card p-3">
					<p className="text-xs text-muted-foreground mb-1">
						API Key (save this — it cannot be retrieved later):
					</p>
					<code className="text-xs font-mono text-foreground break-all">{actor.api_key}</code>
				</div>
			)}
		</div>
	)
}

function RegeneratedApiKeyView({ apiKey }: { apiKey: string }) {
	return (
		<div className="p-4 max-w-2xl">
			<h2 className="text-lg font-semibold text-foreground mb-2">API Key Regenerated</h2>
			{apiKey ? (
				<div className="rounded border border-border bg-card p-3">
					<p className="text-xs text-muted-foreground mb-1">
						New API Key (save this — it cannot be retrieved later):
					</p>
					<code className="text-xs font-mono text-foreground break-all">{apiKey}</code>
				</div>
			) : (
				<p className="text-sm text-muted-foreground">API key regenerated successfully.</p>
			)}
		</div>
	)
}

renderMcpApp('Actors', <ActorsApp />)
