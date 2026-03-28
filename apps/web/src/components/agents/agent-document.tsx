import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useDeleteActor, useUpdateActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useEvents } from '@/hooks/use-events'
import {
	useActiveSessionsForActor,
	useActorSessions,
	useCreateSession,
	useSessionErrorLog,
	useSessionLatestLog,
} from '@/hooks/use-sessions'
import type { ActorResponse, EventResponse, SessionResponse } from '@/lib/api'
import { formatDurationBetween } from '@/lib/format-duration'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import {
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	MinusCircle,
	Trash2,
	XCircle,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ActivityItem } from '../activity/activity-item'
import { PageHeader } from '../layout/page-header'
import { RelativeTime } from '../shared/relative-time'
import { TypeBadge } from '../shared/type-badge'
import { InstructionLog } from './instruction-log'
import { McpServers } from './mcp-servers'
import { Skills } from './skills'

interface AgentDocumentViewProps {
	agent: ActorResponse
	workspaceId: string
	events?: EventResponse[]
	activeSessions?: SessionResponse[]
	recentSessions?: SessionResponse[]
	onUpdateName: (name: string) => void
	onUpdateSystemPrompt: (systemPrompt: string) => void
	onUpdateLlmProvider: (provider: string) => void
	onUpdateLlmConfig: (config: Record<string, unknown>) => void
	onUpdateTools: (tools: Record<string, unknown>) => void
	onUpdateMemory: (memory: Record<string, unknown>) => void
	showSaved?: boolean
}

function useConfigExpanded() {
	const [expanded, setExpanded] = useState(() => {
		try {
			return localStorage.getItem('agent-config-expanded') === 'true'
		} catch {
			return false
		}
	})
	const toggle = useCallback((open: boolean) => {
		setExpanded(open)
		try {
			localStorage.setItem('agent-config-expanded', String(open))
		} catch {}
	}, [])
	return [expanded, toggle] as const
}

export function AgentDocumentView({
	agent,
	workspaceId,
	events,
	activeSessions,
	recentSessions,
	onUpdateName,
	onUpdateSystemPrompt,
	onUpdateLlmProvider,
	onUpdateLlmConfig,
	onUpdateTools,
	onUpdateMemory,
	showSaved = false,
}: AgentDocumentViewProps) {
	const [nameDraft, setNameDraft] = useState(agent.name)
	const [systemPromptDraft, setSystemPromptDraft] = useState(agent.systemPrompt ?? '')
	const [systemPromptDirty, setSystemPromptDirty] = useState(false)
	const [modelDraft, setModelDraft] = useState(
		((agent.llmConfig as Record<string, unknown>)?.model as string) ?? '',
	)
	const [memoryDraft, setMemoryDraft] = useState(
		agent.memory ? JSON.stringify(agent.memory, null, 2) : '{}',
	)
	const [memoryDirty, setMemoryDirty] = useState(false)
	const [memoryError, setMemoryError] = useState<string | null>(null)
	const [configExpanded, setConfigExpanded] = useConfigExpanded()

	const isActive = (activeSessions?.length ?? 0) > 0

	const handleNameBlur = useCallback(() => {
		if (nameDraft.trim() && nameDraft !== agent.name) {
			onUpdateName(nameDraft.trim())
		}
	}, [nameDraft, agent.name, onUpdateName])

	const handleSystemPromptBlur = useCallback(() => {
		if (systemPromptDirty && systemPromptDraft !== (agent.systemPrompt ?? '')) {
			onUpdateSystemPrompt(systemPromptDraft)
		}
		setSystemPromptDirty(false)
	}, [systemPromptDraft, systemPromptDirty, agent.systemPrompt, onUpdateSystemPrompt])

	const handleModelBlur = useCallback(() => {
		const currentModel = ((agent.llmConfig as Record<string, unknown>)?.model as string) ?? ''
		if (modelDraft !== currentModel) {
			onUpdateLlmConfig({ ...(agent.llmConfig ?? {}), model: modelDraft || undefined })
		}
	}, [modelDraft, agent.llmConfig, onUpdateLlmConfig])

	const handleMemorySave = useCallback(() => {
		try {
			const parsed = JSON.parse(memoryDraft)
			setMemoryError(null)
			onUpdateMemory(parsed)
			setMemoryDirty(false)
		} catch {
			setMemoryError('Invalid JSON')
		}
	}, [memoryDraft, onUpdateMemory])

	// Filter out active sessions from recent sessions to avoid duplicates
	const activeIds = useMemo(
		() => new Set((activeSessions ?? []).map((s) => s.id)),
		[activeSessions],
	)
	const pastSessions = useMemo(
		() => (recentSessions ?? []).filter((s) => !activeIds.has(s.id)),
		[recentSessions, activeIds],
	)

	return (
		<div className="max-w-3xl mx-auto">
			{/* Name */}
			<div className="flex items-start gap-2 mb-2">
				<textarea
					value={nameDraft}
					onChange={(e) => {
						setNameDraft(e.target.value)
						e.target.style.height = 'auto'
						e.target.style.height = `${e.target.scrollHeight}px`
					}}
					onBlur={handleNameBlur}
					onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
					placeholder="Agent name"
					rows={1}
					className="w-full text-2xl font-bold tracking-tight bg-transparent border-none outline-none text-foreground resize-none overflow-hidden p-0 focus:outline-none"
					ref={(el) => {
						if (el) {
							el.style.height = 'auto'
							el.style.height = `${el.scrollHeight}px`
						}
					}}
				/>
				{showSaved && (
					<span className="flex items-center gap-1 text-xs text-muted-foreground mt-1.5">
						<Check size={14} /> Saved
					</span>
				)}
			</div>

			{/* Metadata badges row */}
			<div className="flex flex-wrap items-center gap-2 mb-6">
				<TypeBadge type="agent" />
				<span className="flex items-center gap-1.5 text-xs">
					<span
						className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-success animate-pulse' : 'bg-text-muted'}`}
					/>
					<span className="text-muted-foreground">{isActive ? 'active' : 'idle'}</span>
				</span>
				{agent.llmProvider && (
					<span className="text-[11px] text-muted-foreground">{agent.llmProvider}</span>
				)}
				<RelativeTime date={agent.createdAt} className="text-[11px] text-muted-foreground" />
			</div>

			{/* Instruction Log */}
			<InstructionLog agent={agent} workspaceId={workspaceId} />

			{/* Currently Working On */}
			{activeSessions && activeSessions.length > 0 && (
				<Section title="Currently Working On">
					<div className="space-y-2">
						{activeSessions.map((session) => (
							<ActiveSessionCard key={session.id} session={session} workspaceId={workspaceId} />
						))}
					</div>
				</Section>
			)}

			{/* Recent Sessions */}
			{pastSessions.length > 0 && (
				<Section title="Sessions">
					<div className="space-y-1">
						{pastSessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								workspaceId={workspaceId}
								agentId={agent.id}
							/>
						))}
					</div>
				</Section>
			)}

			{/* Configuration (collapsible) */}
			<Collapsible open={configExpanded} onOpenChange={setConfigExpanded}>
				<CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground mb-4 hover:text-foreground transition-colors cursor-pointer">
					{configExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					Configuration
				</CollapsibleTrigger>
				<CollapsibleContent>
					{/* System Prompt */}
					<Section title="System Prompt">
						<Textarea
							value={systemPromptDraft}
							onChange={(e) => {
								setSystemPromptDraft(e.target.value)
								setSystemPromptDirty(true)
							}}
							onBlur={handleSystemPromptBlur}
							placeholder="Instructions for the agent..."
							className="min-h-[120px] font-mono text-sm"
						/>
					</Section>

					{/* LLM Configuration */}
					<Section title="LLM Configuration">
						<div className="flex gap-3">
							<div className="flex-1">
								<Label>Provider</Label>
								<Select
									value={agent.llmProvider ?? 'anthropic'}
									onValueChange={onUpdateLlmProvider}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="anthropic">Anthropic</SelectItem>
										<SelectItem value="openai">OpenAI</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="flex-1">
								<Label>Model</Label>
								<Input
									type="text"
									value={modelDraft}
									onChange={(e) => setModelDraft(e.target.value)}
									onBlur={handleModelBlur}
									placeholder="e.g. claude-sonnet-4-5-20250514"
								/>
							</div>
						</div>
					</Section>

					{/* MCP Servers */}
					<Section title="MCP Servers">
						<McpServers tools={agent.tools} onUpdate={onUpdateTools} />
					</Section>

					{/* Skills */}
					<Section title="Skills">
						<Skills actorId={agent.id} />
					</Section>

					{/* Memory */}
					<Section title="Memory">
						<Textarea
							value={memoryDraft}
							onChange={(e) => {
								setMemoryDraft(e.target.value)
								setMemoryDirty(true)
							}}
							placeholder="{}"
							className="min-h-[100px] font-mono text-sm"
						/>
						{memoryError && <p className="text-xs text-error mt-1">{memoryError}</p>}
						{memoryDirty && (
							<div className="flex justify-end mt-2">
								<button
									type="button"
									className="rounded bg-accent px-3 py-1 text-xs text-accent-foreground hover:bg-accent-hover"
									onClick={handleMemorySave}
								>
									Save Memory
								</button>
							</div>
						)}
					</Section>
				</CollapsibleContent>
			</Collapsible>

			{/* Activity trail */}
			{events && events.length > 0 && (
				<div className="border-t border-border pt-6">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
						Activity
					</h3>
					<div className="space-y-2">
						{events.map((event) => (
							<ActivityItem key={event.id} event={event} compact />
						))}
					</div>
				</div>
			)}
		</div>
	)
}

function Section({
	title,
	children,
}: {
	title: string
	children: React.ReactNode
}) {
	return (
		<div className="mb-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				{title}
			</h3>
			{children}
		</div>
	)
}

function ActiveSessionCard({
	session,
	workspaceId,
}: {
	session: SessionResponse
	workspaceId: string
}) {
	const { data: latestLog } = useSessionLatestLog(session.id, workspaceId)
	const duration = useDuration(session.startedAt)

	return (
		<div className="flex items-center gap-2.5 rounded-md border border-border bg-secondary/50 px-3 py-2">
			<Spinner />
			<span className="text-sm truncate flex-1">{session.actionPrompt}</span>
			{latestLog && (
				<span className="text-xs text-muted-foreground truncate max-w-[200px]">
					{latestLog.content}
				</span>
			)}
			{duration && <span className="text-xs text-muted-foreground shrink-0">{duration}</span>}
		</div>
	)
}

function SessionStatusIcon({ status }: { status: string }) {
	switch (status) {
		case 'completed':
			return <CheckCircle2 size={14} className="text-success shrink-0" />
		case 'failed':
		case 'timeout':
			return <XCircle size={14} className="text-error shrink-0" />
		case 'running':
		case 'starting':
			return <Spinner className="shrink-0" />
		case 'paused':
		case 'snapshotting':
			return <Clock size={14} className="text-warning shrink-0" />
		default:
			return <MinusCircle size={14} className="text-muted-foreground shrink-0" />
	}
}

function SessionRow({
	session,
	workspaceId,
	agentId,
}: {
	session: SessionResponse
	workspaceId: string
	agentId: string
}) {
	const duration = formatDurationBetween(session.startedAt, session.completedAt)
	const isFailed = session.status === 'failed' || session.status === 'timeout'
	const [showError, setShowError] = useState(false)
	const createSession = useCreateSession(workspaceId)

	const result = session.result as Record<string, unknown> | null
	const errorMessage = typeof result?.error === 'string' ? result.error : undefined
	const exitCode = typeof result?.exit_code === 'number' ? result.exit_code : undefined
	const hasResultError = !!errorMessage || (exitCode !== undefined && exitCode !== 0)

	const { data: stderrLog } = useSessionErrorLog(
		session.id,
		workspaceId,
		showError && !hasResultError,
	)

	const errorDetail =
		errorMessage ?? (exitCode !== undefined ? `Process exited with code ${exitCode}` : null)
	const displayError = errorDetail ?? stderrLog

	return (
		<div>
			<div className="flex items-center gap-2.5 rounded-md px-3 py-1.5">
				<SessionStatusIcon status={session.status} />
				<span className={`text-sm truncate flex-1 ${isFailed ? 'text-error' : ''}`}>
					{session.actionPrompt || 'Untitled session'}
				</span>
				{isFailed && (
					<>
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer"
							onClick={() => setShowError((v) => !v)}
						>
							{showError ? 'Hide' : 'Error'}
						</button>
						<button
							type="button"
							className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0 cursor-pointer"
							onClick={() =>
								createSession.mutate({
									actor_id: agentId,
									action_prompt: session.actionPrompt,
								})
							}
							disabled={createSession.isPending}
						>
							{createSession.isPending ? 'Retrying…' : 'Retry'}
						</button>
					</>
				)}
				{duration && <span className="text-xs text-muted-foreground shrink-0">{duration}</span>}
				<RelativeTime
					date={session.completedAt ?? session.createdAt}
					className="text-xs text-muted-foreground shrink-0"
				/>
			</div>
			{showError && displayError && (
				<pre className="text-xs font-mono text-error bg-error/10 rounded p-2 mx-3 mt-1 whitespace-pre-wrap">
					{displayError}
				</pre>
			)}
		</div>
	)
}

export function AgentDocument({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const deleteActor = useDeleteActor(workspaceId)
	const navigate = useNavigate()
	const { data: allEvents } = useEvents(workspaceId, { limit: '50' })
	const { data: activeSessions } = useActiveSessionsForActor(agent.id, workspaceId)
	const { data: recentSessions } = useActorSessions(agent.id, workspaceId)
	// Filter events by this agent's actorId
	const agentEvents = useMemo(
		() => (allEvents ?? []).filter((e) => e.actorId === agent.id),
		[allEvents, agent.id],
	)

	const handleDelete = useCallback(() => {
		deleteActor.mutate(agent.id, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId/agents', params: { workspaceId } })
			},
		})
	}, [agent.id, deleteActor, navigate, workspaceId])

	const handleUpdateName = useCallback(
		(name: string) => {
			updateActor.mutate({ id: agent.id, data: { name } })
		},
		[agent.id, updateActor],
	)

	const handleUpdateSystemPrompt = useCallback(
		(system_prompt: string) => {
			updateActor.mutate({ id: agent.id, data: { system_prompt } })
		},
		[agent.id, updateActor],
	)

	const handleUpdateLlmProvider = useCallback(
		(llm_provider: string) => {
			updateActor.mutate({ id: agent.id, data: { llm_provider } })
		},
		[agent.id, updateActor],
	)

	const handleUpdateLlmConfig = useCallback(
		(llm_config: Record<string, unknown>) => {
			updateActor.mutate({ id: agent.id, data: { llm_config } })
		},
		[agent.id, updateActor],
	)

	const handleUpdateTools = useCallback(
		(tools: Record<string, unknown>) => {
			updateActor.mutate({ id: agent.id, data: { tools } })
		},
		[agent.id, updateActor],
	)

	const handleUpdateMemory = useCallback(
		(memory: Record<string, unknown>) => {
			updateActor.mutate({ id: agent.id, data: { memory } })
		},
		[agent.id, updateActor],
	)

	return (
		<>
			<PageHeader
				actions={
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 text-muted-foreground hover:text-error"
						onClick={handleDelete}
					>
						<Trash2 size={15} />
					</Button>
				}
			/>
			<AgentDocumentView
				agent={agent}
				workspaceId={workspaceId}
				events={agentEvents}
				activeSessions={activeSessions}
				recentSessions={recentSessions}
				onUpdateName={handleUpdateName}
				onUpdateSystemPrompt={handleUpdateSystemPrompt}
				onUpdateLlmProvider={handleUpdateLlmProvider}
				onUpdateLlmConfig={handleUpdateLlmConfig}
				onUpdateTools={handleUpdateTools}
				onUpdateMemory={handleUpdateMemory}
			/>
		</>
	)
}
