import { Badge } from '@/components/ui/badge'
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
	usePauseSession,
	useResumeSession,
	useSessionLogs,
	useStopSession,
} from '@/hooks/use-sessions'
import type { ActorResponse, EventResponse, SessionLogResponse, SessionResponse } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { API_BASE } from '@/lib/constants'
import { formatDurationBetween } from '@/lib/format-duration'
import { type LogSegment, countToolCalls, parseLogLines } from '@/lib/parse-session-logs'
import { useWorkspace } from '@/lib/workspace-context'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useNavigate } from '@tanstack/react-router'
import {
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Code,
	MinusCircle,
	Pause,
	Square,
	Trash2,
	XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
							<LiveSessionPanel key={session.id} session={session} workspaceId={workspaceId} />
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
							autoResize
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

function LiveSessionPanel({
	session,
	workspaceId,
}: {
	session: SessionResponse
	workspaceId: string
}) {
	const duration = useDuration(session.startedAt)
	const stopSession = useStopSession(workspaceId)
	const pauseSession = usePauseSession(workspaceId)
	const [expanded, setExpanded] = useState(false)
	const [liveLogs, setLiveLogs] = useState<string[]>([])
	const logsEndRef = useRef<HTMLDivElement>(null)

	// SSE streaming for live logs when expanded
	useEffect(() => {
		if (!expanded) return

		const controller = new AbortController()
		fetchEventSource(`${API_BASE}/sessions/${session.id}/logs/stream`, {
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${getApiKey()}`,
				'X-Workspace-Id': workspaceId,
			},
			onmessage(msg) {
				if (!msg.data) return
				if (msg.event === 'stdout' || msg.event === 'stderr') {
					setLiveLogs((prev) => [...prev, msg.data])
				}
			},
			onerror() {
				controller.abort()
			},
			openWhenHidden: true,
		})

		return () => controller.abort()
	}, [expanded, session.id, workspaceId])

	// Auto-scroll when logs update
	useEffect(() => {
		if (expanded && liveLogs.length > 0) {
			logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
		}
	}, [expanded, liveLogs.length])

	const segments = useMemo(() => parseLogLines(liveLogs), [liveLogs])
	const toolCallCount = useMemo(() => countToolCalls(segments), [segments])

	return (
		<div className="rounded-md border border-accent/50 bg-accent/5 overflow-hidden">
			{/* Status bar — always visible */}
			<div className="flex items-center gap-2.5 px-3 py-2">
				<span className="h-2 w-2 rounded-full bg-accent animate-pulse shrink-0" />
				<Spinner className="shrink-0" />
				<span className="text-sm truncate flex-1">{session.actionPrompt}</span>
				{toolCallCount > 0 && (
					<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
						<Code size={10} />
						{toolCallCount}
					</span>
				)}
				{duration && <span className="text-xs text-muted-foreground shrink-0">{duration}</span>}
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6 text-muted-foreground hover:text-warning shrink-0"
					onClick={() => pauseSession.mutate(session.id)}
					disabled={pauseSession.isPending}
				>
					<Pause size={12} />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6 text-muted-foreground hover:text-error shrink-0"
					onClick={() => stopSession.mutate(session.id)}
					disabled={stopSession.isPending}
				>
					<Square size={12} />
				</Button>
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
				>
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</button>
			</div>

			{/* Expanded live logs */}
			{expanded && (
				<div className="border-t border-accent/20 px-3 py-2 max-h-[400px] overflow-y-auto">
					{liveLogs.length === 0 ? (
						<span className="text-xs text-muted-foreground">Waiting for output...</span>
					) : (
						<div className="space-y-1.5">
							{segments.map((seg, i) => (
								<LiveSegment key={`${seg.type}-${i}`} segment={seg} />
							))}
						</div>
					)}
					<div ref={logsEndRef} />
				</div>
			)}
		</div>
	)
}

function LiveSegment({ segment }: { segment: LogSegment }) {
	if (segment.type === 'tool_call') {
		return (
			<div className="flex items-center gap-1.5">
				<Code size={10} className="text-accent shrink-0" />
				<span className="text-[11px] font-mono text-accent">{segment.toolName ?? 'tool'}</span>
				{segment.content && (
					<span className="text-[10px] text-muted-foreground truncate">
						{segment.content.split('\n')[0]}
					</span>
				)}
			</div>
		)
	}
	if (segment.type === 'tool_result') {
		return (
			<pre className="ml-4 text-[10px] font-mono text-muted-foreground truncate">
				{segment.content.split('\n')[0]}
			</pre>
		)
	}
	if (segment.type === 'error') {
		return <pre className="text-[10px] font-mono text-error">{segment.content}</pre>
	}
	if (segment.type === 'system') {
		return <p className="text-[10px] text-muted-foreground italic">{segment.content}</p>
	}
	// text / thinking
	return <p className="text-[11px] text-muted-foreground truncate">{segment.content}</p>
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
	const isPaused = session.status === 'paused' || session.status === 'snapshotting'
	const [expanded, setExpanded] = useState(false)
	const createSession = useCreateSession(workspaceId)
	const resumeSession = useResumeSession(workspaceId)

	const result = session.result as Record<string, unknown> | null
	const errorMessage = typeof result?.error === 'string' ? result.error : undefined
	const exitCode = typeof result?.exit_code === 'number' ? result.exit_code : undefined

	return (
		<div>
			<button
				type="button"
				className="flex items-center gap-2.5 rounded-md px-3 py-1.5 w-full text-left hover:bg-hover/50 transition-colors cursor-pointer"
				onClick={() => setExpanded((v) => !v)}
			>
				<SessionStatusIcon status={session.status} />
				<span className={cn('text-sm truncate flex-1', isFailed && 'text-error')}>
					{session.actionPrompt || 'Untitled session'}
				</span>
				{isFailed && (
					<span
						className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0"
						onClick={(e) => {
							e.stopPropagation()
							createSession.mutate({
								actor_id: agentId,
								action_prompt: session.actionPrompt,
							})
						}}
						onKeyDown={() => {}}
						role="button"
						tabIndex={0}
					>
						{createSession.isPending ? 'Retrying…' : 'Retry'}
					</span>
				)}
				{isPaused && (
					<span
						className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0"
						onClick={(e) => {
							e.stopPropagation()
							resumeSession.mutate(session.id)
						}}
						onKeyDown={() => {}}
						role="button"
						tabIndex={0}
					>
						{resumeSession.isPending ? 'Resuming…' : 'Resume'}
					</span>
				)}
				{duration && <span className="text-xs text-muted-foreground shrink-0">{duration}</span>}
				<RelativeTime
					date={session.completedAt ?? session.createdAt}
					className="text-xs text-muted-foreground shrink-0"
				/>
				<ChevronRight
					size={12}
					className={cn(
						'text-muted-foreground transition-transform shrink-0',
						expanded && 'rotate-90',
					)}
				/>
			</button>

			{expanded && (
				<SessionDetail
					session={session}
					workspaceId={workspaceId}
					errorMessage={errorMessage}
					exitCode={exitCode}
				/>
			)}
		</div>
	)
}

function SessionDetail({
	session,
	workspaceId,
	errorMessage,
	exitCode,
}: {
	session: SessionResponse
	workspaceId: string
	errorMessage?: string
	exitCode?: number
}) {
	const { data: logs, isLoading } = useSessionLogs(session.id, workspaceId)

	const segments = useMemo(() => {
		if (!logs || logs.length === 0) return []
		const stdoutLogs = logs
			.filter((l: SessionLogResponse) => l.stream === 'stdout')
			.map((l: SessionLogResponse) => l.content)
		return parseLogLines(stdoutLogs)
	}, [logs])

	const toolCallCount = useMemo(() => countToolCalls(segments), [segments])
	const errorCount = useMemo(() => {
		if (!logs) return 0
		return logs.filter((l: SessionLogResponse) => l.stream === 'stderr').length
	}, [logs])

	return (
		<div className="mx-3 mb-2 mt-1 rounded-md border border-border bg-bg-surface p-3">
			{/* Summary badges */}
			<div className="flex items-center gap-2 mb-3">
				<Badge variant="outline" className="text-[10px]">
					{session.status}
				</Badge>
				{toolCallCount > 0 && (
					<Badge variant="outline" className="text-[10px]">
						<Code size={10} className="mr-0.5" />
						{toolCallCount} tool call{toolCallCount > 1 ? 's' : ''}
					</Badge>
				)}
				{errorCount > 0 && (
					<Badge variant="outline" className="text-[10px] text-error">
						{errorCount} error{errorCount > 1 ? 's' : ''}
					</Badge>
				)}
				{session.startedAt && (
					<span className="text-[10px] text-muted-foreground">
						{formatDurationBetween(session.startedAt, session.completedAt)}
					</span>
				)}
			</div>

			{/* Error detail */}
			{(errorMessage || (exitCode !== undefined && exitCode !== 0)) && (
				<pre className="text-xs font-mono text-error bg-error/10 rounded p-2 mb-3 whitespace-pre-wrap">
					{errorMessage ?? `Process exited with code ${exitCode}`}
				</pre>
			)}

			{/* Timeline */}
			{isLoading ? (
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<Spinner /> Loading logs...
				</div>
			) : segments.length === 0 ? (
				<p className="text-xs text-muted-foreground">No logs recorded for this session.</p>
			) : (
				<SessionTimeline segments={segments} />
			)}
		</div>
	)
}

function SessionTimeline({ segments }: { segments: LogSegment[] }) {
	return (
		<div className="relative border-l-2 border-border pl-3 space-y-2">
			{segments.map((seg, i) => (
				<TimelineNode key={`${seg.type}-${i}`} segment={seg} />
			))}
		</div>
	)
}

function TimelineNode({ segment }: { segment: LogSegment }) {
	const [open, setOpen] = useState(false)
	const dotColor =
		segment.type === 'tool_call' ? 'bg-accent' : segment.type === 'error' ? 'bg-error' : 'bg-border'

	if (segment.type === 'tool_call') {
		return (
			<div className="relative">
				<span className={cn('absolute -left-[17px] top-1 h-2 w-2 rounded-full', dotColor)} />
				<Collapsible open={open} onOpenChange={setOpen}>
					<CollapsibleTrigger className="flex items-center gap-1.5 cursor-pointer hover:text-foreground transition-colors">
						<Code size={10} className="text-accent" />
						<span className="text-[11px] font-mono font-medium">{segment.toolName}</span>
						{segment.content && (
							<ChevronRight
								size={10}
								className={cn('text-muted-foreground transition-transform', open && 'rotate-90')}
							/>
						)}
					</CollapsibleTrigger>
					{segment.content && (
						<CollapsibleContent>
							<pre className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
								{segment.content}
							</pre>
						</CollapsibleContent>
					)}
				</Collapsible>
			</div>
		)
	}

	if (segment.type === 'tool_result') {
		const isLong = segment.content.length > 150
		return (
			<div className="relative">
				<span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-border" />
				{isLong ? (
					<Collapsible open={open} onOpenChange={setOpen}>
						<CollapsibleTrigger className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
							Result ({segment.content.split('\n').length} lines)
							<ChevronRight
								size={10}
								className={cn('inline ml-0.5 transition-transform', open && 'rotate-90')}
							/>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<pre className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
								{segment.content}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				) : (
					<pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap">
						{segment.content}
					</pre>
				)}
			</div>
		)
	}

	if (segment.type === 'error') {
		return (
			<div className="relative">
				<span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-error" />
				<pre className="text-[10px] font-mono text-error whitespace-pre-wrap">
					{segment.content}
				</pre>
			</div>
		)
	}

	if (segment.type === 'thinking') {
		return (
			<div className="relative">
				<span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-warning/50" />
				<p className="text-[10px] text-muted-foreground italic truncate">{segment.content}</p>
			</div>
		)
	}

	// text / system
	if (segment.content.length > 200) {
		return (
			<div className="relative">
				<span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-border" />
				<Collapsible open={open} onOpenChange={setOpen}>
					<CollapsibleTrigger className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
						{segment.content.slice(0, 80)}...
						<ChevronRight
							size={10}
							className={cn('inline ml-0.5 transition-transform', open && 'rotate-90')}
						/>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<p className="mt-1 text-[11px] text-foreground whitespace-pre-wrap">
							{segment.content}
						</p>
					</CollapsibleContent>
				</Collapsible>
			</div>
		)
	}

	return (
		<div className="relative">
			<span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-border" />
			<p className="text-[11px] text-foreground">{segment.content}</p>
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

	const [confirmDelete, setConfirmDelete] = useState(false)

	const handleDelete = useCallback(() => {
		deleteActor.mutate(agent.id, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId/agents', params: { workspaceId } })
			},
		})
	}, [agent.id, deleteActor, navigate, workspaceId])

	const deleteActions = useMemo(
		() =>
			confirmDelete ? (
				<div className="flex items-center gap-2">
					<span className="text-xs text-error">Delete this agent?</span>
					<Button
						variant="destructive"
						size="sm"
						onClick={handleDelete}
						disabled={deleteActor.isPending}
					>
						{deleteActor.isPending ? 'Deleting...' : 'Confirm'}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
						Cancel
					</Button>
				</div>
			) : (
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 text-muted-foreground hover:text-error"
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2 size={15} />
				</Button>
			),
		[confirmDelete, handleDelete, deleteActor.isPending],
	)

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
			<PageHeader actions={deleteActions} />
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
