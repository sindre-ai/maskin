import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { ActorResponse, ActorWithKey, SessionResponse } from '../shared/types'
import { WebAppLink, useWebAppHref } from '../shared/web-app-link'

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
						<ActorAgentRow
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
						<ActorHumanRow key={actor.id} actor={actor} />
					))}
				</div>
			)}
		</div>
	)
}

function ActorAgentRow({
	agent,
	status,
	latestSession,
}: {
	agent: ActorResponse
	status: ReturnType<typeof deriveAgentStatus>
	latestSession?: SessionResponse
}) {
	const href = useWebAppHref({ kind: 'actor', id: agent.id })
	const description = agent.description?.trim()
	const content = (
		<>
			<div className="flex items-center justify-between gap-2 mb-1">
				<div className="flex items-center gap-2 min-w-0">
					<ActorAvatar name={agent.name} type="agent" size="md" />
					<span className="text-sm font-medium text-foreground truncate min-w-0">{agent.name}</span>
					<span
						className={`h-1.5 w-1.5 rounded-full ${
							status === 'failed'
								? 'bg-error'
								: status === 'working'
									? 'bg-status-in_progress-text'
									: 'bg-text-muted'
						}`}
					/>
				</div>
				<span className="text-xs font-medium text-muted-foreground">{status}</span>
			</div>
			{description && (
				<p className="text-xs text-muted-foreground mb-3 ml-9 line-clamp-1">{description}</p>
			)}
			<p className="text-xs text-muted-foreground truncate ml-9">
				{latestSession?.actionPrompt ?? 'No activity yet'}
				{latestSession?.completedAt && (
					<>
						{' · '}
						<RelativeTime date={latestSession.completedAt} className="text-muted-foreground" />
					</>
				)}
			</p>
		</>
	)
	if (!href) {
		return <div className="rounded-lg border border-border bg-card p-4 shadow-md">{content}</div>
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="block rounded-lg border border-border bg-card p-4 shadow-md transition-colors hover:border-border-hover no-underline"
		>
			{content}
		</a>
	)
}

function ActorHumanRow({ actor }: { actor: ActorResponse }) {
	const href = useWebAppHref({ kind: 'actor', id: actor.id })
	const content = (
		<>
			<ActorAvatar name={actor.name} type={actor.type} size="sm" />
			<div className="flex-1 min-w-0">
				<span className="text-sm text-foreground">{actor.name}</span>
				{actor.email && <span className="text-xs text-muted-foreground ml-2">{actor.email}</span>}
			</div>
			<span className="text-xs text-muted-foreground capitalize">{actor.type}</span>
		</>
	)
	if (!href) {
		return <div className="flex items-center gap-3 px-3 py-2 rounded-lg">{content}</div>
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors no-underline"
		>
			{content}
		</a>
	)
}

function ActorDetailView({ actor }: { actor: ActorResponse }) {
	return (
		<div className="p-4 max-w-2xl">
			<div className="flex items-start justify-between gap-3 mb-4">
				<div className="flex items-center gap-3">
					<ActorAvatar name={actor.name} type={actor.type} />
					<div>
						<h1 className="text-lg font-semibold text-foreground">{actor.name}</h1>
						<span className="text-xs text-muted-foreground capitalize">{actor.type}</span>
					</div>
				</div>
				<WebAppLink target={{ kind: 'actor', id: actor.id }} />
			</div>
			{actor.email && (
				<div className="text-sm text-muted-foreground mb-2">
					<span className="text-muted-foreground">Email:</span> {actor.email}
				</div>
			)}
			{actor.system_prompt && (
				<div className="border-t border-border pt-3 mt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Instructions
					</h3>
					<p className="text-sm text-muted-foreground whitespace-pre-wrap">{actor.system_prompt}</p>
				</div>
			)}
			{actor.llm_provider && (
				<div className="text-sm text-muted-foreground mt-2">
					<span className="text-muted-foreground">LLM:</span> {actor.llm_provider}
					{actor.llm_config?.model ? ` / ${String(actor.llm_config.model)}` : null}
				</div>
			)}
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
