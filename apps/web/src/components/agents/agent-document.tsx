import { ForkDialog } from '@/components/marketplace/fork-dialog'
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
import {
	useActors,
	useAgentPause,
	useAgentRun,
	useDeleteActor,
	useResetActor,
	useUpdateActor,
} from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useEvents } from '@/hooks/use-events'
import { useInstalledPackages } from '@/hooks/use-installed-packages'
import {
	useActiveSessionsForActor,
	useActorSessionsInfinite,
	useCreateSession,
	useSessionErrorLog,
	useSessionLogs,
} from '@/hooks/use-sessions'
import type { ActorListItem, ActorResponse, EventResponse, SessionResponse } from '@/lib/api'
import { useChat } from '@/lib/chat-context'
import { cn } from '@/lib/cn'
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
	PauseCircle,
	RotateCcw,
	Trash2,
	XCircle,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ActivityItem } from '../activity/activity-item'
import { PageHeader } from '../layout/page-header'
import { ObjectReference } from '../shared/object-reference'
import { RelativeTime } from '../shared/relative-time'
import { TypeBadge } from '../shared/type-badge'
import { AgentRunPauseButton } from './agent-run-pause-button'
import { AgentUsageChart } from './agent-usage-chart'
import { McpServers } from './mcp-servers'
import { FailureCard, SessionDetailPanel, parseFailureReason } from './session-detail-panel'
import { getLatestActivityPreview, isSessionIdleAwaitingInput } from './session-log-transcript'
import { Skills } from './skills'

interface AgentDocumentViewProps {
	agent: ActorResponse
	workspaceId: string
	events?: EventResponse[]
	activeSessions?: SessionResponse[]
	recentSessions?: SessionResponse[]
	hasMoreSessions?: boolean
	isLoadingMoreSessions?: boolean
	onLoadMoreSessions?: () => void
	onUpdateName: (name: string) => void
	onUpdateDescription: (description: string) => void
	onUpdateSystemPrompt: (systemPrompt: string) => void
	onUpdateLlmProvider: (provider: string) => void
	onUpdateLlmConfig: (config: Record<string, unknown>) => void
	onUpdateTools: (tools: Record<string, unknown>) => void
	onUpdateMemory: (memory: Record<string, unknown>) => void
	onRun: () => void
	onPause: () => void
	onNewConversation: () => void
	isRunPending?: boolean
	isPausePending?: boolean
	showSaved?: boolean
	isManaged?: boolean
	onForkPackage?: () => void
	managedPackageName?: string
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
	hasMoreSessions = false,
	isLoadingMoreSessions = false,
	onLoadMoreSessions,
	onUpdateName,
	onUpdateDescription,
	onUpdateSystemPrompt,
	onUpdateLlmProvider,
	onUpdateLlmConfig,
	onUpdateTools,
	onUpdateMemory,
	onRun,
	onPause,
	onNewConversation,
	isRunPending = false,
	isPausePending = false,
	showSaved = false,
	isManaged = false,
	onForkPackage,
	managedPackageName,
}: AgentDocumentViewProps) {
	const [nameDraft, setNameDraft] = useState(agent.name)
	const [descriptionDraft, setDescriptionDraft] = useState(agent.description ?? '')
	const [systemPromptDraft, setSystemPromptDraft] = useState(agent.system_prompt ?? '')
	const [systemPromptDirty, setSystemPromptDirty] = useState(false)
	const [modelDraft, setModelDraft] = useState(
		((agent.llm_config as Record<string, unknown>)?.model as string) ?? '',
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

	const handleDescriptionBlur = useCallback(() => {
		const next = descriptionDraft.trim()
		if (next !== (agent.description ?? '')) {
			onUpdateDescription(next)
		}
	}, [descriptionDraft, agent.description, onUpdateDescription])

	const handleSystemPromptBlur = useCallback(() => {
		if (systemPromptDirty && systemPromptDraft !== (agent.system_prompt ?? '')) {
			onUpdateSystemPrompt(systemPromptDraft)
		}
		setSystemPromptDirty(false)
	}, [systemPromptDraft, systemPromptDirty, agent.system_prompt, onUpdateSystemPrompt])

	const handleModelBlur = useCallback(() => {
		const currentModel = ((agent.llm_config as Record<string, unknown>)?.model as string) ?? ''
		if (modelDraft !== currentModel) {
			onUpdateLlmConfig({ ...(agent.llm_config ?? {}), model: modelDraft || undefined })
		}
	}, [modelDraft, agent.llm_config, onUpdateLlmConfig])

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

	const [selectedSession, setSelectedSession] = useState<SessionResponse | null>(null)

	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

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
		<div className="w-full min-w-0 max-w-3xl mx-auto">
			{/* Name */}
			<div className="flex items-start gap-2 mb-2">
				<textarea
					value={nameDraft}
					onChange={(e) => {
						if (isManaged) return
						setNameDraft(e.target.value)
						e.target.style.height = 'auto'
						e.target.style.height = `${e.target.scrollHeight}px`
					}}
					onBlur={isManaged ? undefined : handleNameBlur}
					onKeyDown={(e) => !isManaged && e.key === 'Enter' && e.currentTarget.blur()}
					placeholder="Agent name"
					aria-label="Agent name"
					rows={1}
					readOnly={isManaged}
					className={`w-full text-2xl font-bold tracking-tight bg-transparent border-none outline-none text-foreground resize-none overflow-hidden p-0 focus:outline-none ${isManaged ? 'cursor-default select-text' : ''}`}
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

			{/* Description (short one-liner shown on the Agents page card) */}
			<Input
				type="text"
				value={descriptionDraft}
				onChange={(e) => !isManaged && setDescriptionDraft(e.target.value)}
				onBlur={isManaged ? undefined : handleDescriptionBlur}
				onKeyDown={(e) => !isManaged && e.key === 'Enter' && e.currentTarget.blur()}
				placeholder="Short description shown on the Agents page"
				aria-label="Short description"
				maxLength={80}
				readOnly={isManaged}
				className={`mb-3 border-none bg-transparent px-0 text-sm text-muted-foreground shadow-none focus-visible:ring-0 ${isManaged ? 'cursor-default' : ''}`}
			/>

			{/* Metadata badges row */}
			<div className="flex flex-wrap items-center gap-2 mb-6">
				<TypeBadge type="agent" />
				<span className="flex items-center gap-1.5 text-xs">
					<span
						aria-hidden="true"
						className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-success animate-pulse' : 'bg-text-muted'}`}
					/>
					<span className="text-muted-foreground">{isActive ? 'active' : 'idle'}</span>
				</span>
				{agent.llm_provider && (
					<span className="text-[11px] text-muted-foreground">{agent.llm_provider}</span>
				)}
				<RelativeTime date={agent.createdAt} className="text-[11px] text-muted-foreground" />
				{isManaged && (
					<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span>🔒</span>
						<span>Managed{managedPackageName ? ` · ${managedPackageName}` : ''}</span>
						<button
							type="button"
							onClick={onForkPackage}
							className="text-primary hover:underline cursor-pointer"
						>
							Fork to edit
						</button>
					</span>
				)}
			</div>

			{/* Run/Pause + New Conversation */}
			<div className="flex items-center gap-2 mb-6">
				<AgentRunPauseButton
					isActive={isActive}
					onRun={onRun}
					onPause={onPause}
					isRunPending={isRunPending}
					isPausePending={isPausePending}
				/>
				<Button variant="outline" size="sm" className="min-h-[44px]" onClick={onNewConversation}>
					New Conversation
				</Button>
			</div>

			{/* Usage chart */}
			<AgentUsageChart agent={agent} workspaceId={workspaceId} />

			{/* Currently Working On */}
			{activeSessions && activeSessions.length > 0 && (
				<Section title="Currently Working On">
					<div className="space-y-2">
						{activeSessions.map((session) => (
							<ActiveSessionCard
								key={session.id}
								session={session}
								workspaceId={workspaceId}
								onSelect={setSelectedSession}
							/>
						))}
					</div>
				</Section>
			)}

			{/* Recent Sessions */}
			{pastSessions.length > 0 && (
				<Section title="Sessions">
					<div
						className={cn('space-y-1', pastSessions.length > 10 && 'max-h-[400px] overflow-y-auto')}
					>
						{pastSessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								workspaceId={workspaceId}
								agentId={agent.id}
								onSelect={setSelectedSession}
							/>
						))}
					</div>
					{hasMoreSessions && (
						<Button
							variant="ghost"
							size="sm"
							className="mt-2"
							disabled={isLoadingMoreSessions}
							onClick={() => onLoadMoreSessions?.()}
						>
							<ChevronDown size={14} /> {isLoadingMoreSessions ? 'Loading…' : 'Show more'}
						</Button>
					)}
				</Section>
			)}

			<SessionDetailPanel
				session={selectedSession}
				workspaceId={workspaceId}
				open={selectedSession !== null}
				onOpenChange={(open) => {
					if (!open) setSelectedSession(null)
				}}
			/>

			{/* Configuration (collapsible) */}
			<Collapsible open={configExpanded} onOpenChange={setConfigExpanded}>
				<CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground mb-4 hover:text-foreground transition-colors cursor-pointer">
					{configExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					Configuration
					{isManaged && (
						<span className="ml-auto flex items-center gap-1 normal-case tracking-normal font-normal text-[11px] text-muted-foreground">
							<span>🔒</span>
							<span>Managed{managedPackageName ? ` · ${managedPackageName}` : ''}</span>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation()
									onForkPackage?.()
								}}
								className="text-primary hover:underline cursor-pointer"
							>
								Fork to edit
							</button>
						</span>
					)}
				</CollapsibleTrigger>
				<CollapsibleContent>
					{/* Instructions */}
					<Section title="Instructions">
						<Textarea
							value={systemPromptDraft}
							onChange={(e) => {
								if (isManaged) return
								setSystemPromptDraft(e.target.value)
								setSystemPromptDirty(true)
							}}
							onBlur={isManaged ? undefined : handleSystemPromptBlur}
							placeholder="Instructions for the agent..."
							className={`min-h-[120px] font-mono text-sm ${isManaged ? 'cursor-default' : ''}`}
							autoResize
							readOnly={isManaged}
						/>
					</Section>

					{/* LLM Configuration */}
					<Section title="LLM Configuration">
						<div className="flex flex-col sm:flex-row gap-3">
							<div className="flex-1">
								<Label>Provider</Label>
								<Select
									value={agent.llm_provider ?? 'anthropic'}
									onValueChange={isManaged ? undefined : onUpdateLlmProvider}
									disabled={isManaged}
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
									onChange={(e) => !isManaged && setModelDraft(e.target.value)}
									onBlur={isManaged ? undefined : handleModelBlur}
									placeholder="e.g. claude-opus-4-7"
									readOnly={isManaged}
								/>
							</div>
						</div>
					</Section>

					{/* MCP Servers */}
					<Section title="MCP Servers">
						<McpServers tools={agent.tools} onUpdate={onUpdateTools} readOnly={isManaged} />
					</Section>

					{/* Skills */}
					<Section title="Skills">
						<Skills actorId={agent.id} readOnly={isManaged} />
					</Section>

					{/* Memory */}
					<Section title="Memory">
						<Textarea
							value={memoryDraft}
							onChange={(e) => {
								if (isManaged) return
								setMemoryDraft(e.target.value)
								setMemoryDirty(true)
							}}
							placeholder="{}"
							className={`min-h-[100px] font-mono text-sm ${isManaged ? 'cursor-default' : ''}`}
							readOnly={isManaged}
						/>
						{memoryError && <p className="text-xs text-error mt-1">{memoryError}</p>}
						{!isManaged && memoryDirty && (
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
							<ActivityItem key={event.id} event={event} compact actorsById={actorsById} />
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
	onSelect,
}: {
	session: SessionResponse
	workspaceId: string
	onSelect?: (session: SessionResponse) => void
}) {
	const { data: logs } = useSessionLogs(session.id, workspaceId, true, { live: true })
	const duration = useDuration(session.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])

	return (
		<button
			type="button"
			className="flex w-full items-center gap-2.5 rounded-md border border-border bg-secondary/50 px-3 py-2 min-h-[44px] min-w-0 text-left hover:bg-secondary transition-colors cursor-pointer"
			onClick={() => onSelect?.(session)}
		>
			{idle ? <PauseCircle size={14} className="shrink-0 text-foreground/60" /> : <Spinner />}
			<span className="text-sm truncate flex-1 min-w-0">{session.actionPrompt}</span>
			{preview && (
				<span className="text-xs text-foreground/60 truncate max-w-[120px] sm:max-w-[200px]">
					{preview}
				</span>
			)}
			{duration && <span className="text-xs text-foreground/60 shrink-0">{duration}</span>}
		</button>
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

export function getSessionSummary(session: SessionResponse): string {
	const MAX = 120
	const prompt = session.actionPrompt ?? ''
	const truncated = prompt.length > MAX ? `${prompt.slice(0, MAX)}…` : prompt
	const fallback = truncated || 'Untitled session'

	switch (session.status) {
		case 'running':
		case 'starting':
			return fallback === 'Untitled session' ? fallback : `Working on: ${fallback}`
		case 'paused':
		case 'snapshotting':
			return fallback === 'Untitled session' ? fallback : `Paused: ${fallback}`
		case 'completed':
		case 'failed':
		case 'timeout':
			return fallback
		default:
			return fallback
	}
}

function SessionRow({
	session,
	workspaceId,
	agentId,
	onSelect,
}: {
	session: SessionResponse
	workspaceId: string
	agentId: string
	onSelect?: (session: SessionResponse) => void
}) {
	const duration = formatDurationBetween(session.startedAt, session.completedAt)
	const isFailed = session.status === 'failed' || session.status === 'timeout'
	const [showError, setShowError] = useState(false)
	const createSession = useCreateSession(workspaceId)

	const result = session.result as Record<string, unknown> | null
	const errorMessage = typeof result?.error === 'string' ? result.error : undefined
	const rawExitCode = result?.exit_code
	const exitCode: number | null | undefined =
		typeof rawExitCode === 'number' || rawExitCode === null ? rawExitCode : undefined
	const hasResultError = !!errorMessage || (exitCode !== undefined && exitCode !== 0)
	const failureReason = parseFailureReason(result)

	const { data: stderrLog } = useSessionErrorLog(
		session.id,
		workspaceId,
		showError && !hasResultError && !failureReason,
	)

	const errorDetail =
		errorMessage ??
		(exitCode !== undefined
			? exitCode !== null
				? `Process exited with code ${exitCode}`
				: 'Container process was killed'
			: null)
	const displayError = errorDetail ?? stderrLog

	const resultObjects = Array.isArray(result?.objects)
		? (result.objects as unknown[]).filter(
				(item): item is { id: string } =>
					typeof item === 'object' &&
					item !== null &&
					typeof (item as Record<string, unknown>).id === 'string',
			)
		: []

	return (
		<div>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: row click supplements keyboard-accessible inner buttons and sr-only open button */}
			<div
				className="flex items-center gap-2.5 rounded-md px-3 py-1.5 min-h-[44px] min-w-0 hover:bg-secondary/50 transition-colors cursor-pointer"
				onClick={() => onSelect?.(session)}
			>
				<SessionStatusIcon status={session.status} />
				<span className={`text-sm truncate flex-1 min-w-0 ${isFailed ? 'text-error' : ''}`}>
					{getSessionSummary(session)}
				</span>
				{isFailed && (
					<>
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer min-h-[44px] inline-flex items-center"
							onClick={(e) => {
								e.stopPropagation()
								setShowError((v) => !v)
							}}
						>
							{showError ? 'Hide' : 'Error'}
						</button>
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer min-h-[44px] inline-flex items-center"
							onClick={(e) => {
								e.stopPropagation()
								createSession.mutate({
									actor_id: agentId,
									action_prompt: session.actionPrompt,
								})
							}}
							disabled={createSession.isPending}
						>
							{createSession.isPending ? 'Restarting…' : 'Restart'}
						</button>
					</>
				)}
				{duration && <span className="text-xs text-muted-foreground shrink-0">{duration}</span>}
				<RelativeTime
					date={session.completedAt ?? session.createdAt}
					className="text-xs text-muted-foreground shrink-0"
				/>
			</div>
			{showError &&
				(failureReason ? (
					<div className="mx-3 mt-1">
						<FailureCard failureReason={failureReason} workspaceId={workspaceId} />
					</div>
				) : (
					displayError && (
						<pre className="text-xs font-mono text-error bg-error/10 rounded p-2 mx-3 mt-1 whitespace-pre-wrap break-words">
							{displayError}
						</pre>
					)
				))}
			{resultObjects.length > 0 && (
				<div className="flex flex-wrap gap-1.5 px-3 pb-1.5 pt-0.5">
					{resultObjects.map((item) => (
						<ObjectReference
							key={item.id}
							variant="inline"
							objectId={item.id}
							workspaceId={workspaceId}
							showStatus={false}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export function AgentDocument({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const deleteActor = useDeleteActor(workspaceId)
	const resetActor = useResetActor(workspaceId)
	const run = useAgentRun(workspaceId)
	const pause = useAgentPause(workspaceId)
	const { openWithContext } = useChat()
	const navigate = useNavigate()
	const { data: allEvents } = useEvents(workspaceId, { limit: '50' })
	const { data: activeSessions } = useActiveSessionsForActor(agent.id, workspaceId)
	const {
		data: recentSessionPages,
		hasNextPage: hasMoreSessions,
		isFetchingNextPage: isLoadingMoreSessions,
		fetchNextPage,
	} = useActorSessionsInfinite(agent.id, workspaceId)
	const recentSessions = useMemo(() => recentSessionPages?.pages.flat() ?? [], [recentSessionPages])
	// Filter events by this agent's actorId
	const agentEvents = useMemo(
		() => (allEvents ?? []).filter((e) => e.actorId === agent.id),
		[allEvents, agent.id],
	)

	// Managed package detection
	const isManaged = !!agent.installedPackageId
	const { data: installedPackagesData } = useInstalledPackages(workspaceId)
	const installRecord = useMemo(
		() => installedPackagesData?.installs.find((i) => i.id === agent.installedPackageId) ?? null,
		[installedPackagesData, agent.installedPackageId],
	)
	const [forkOpen, setForkOpen] = useState(false)

	const [confirmDelete, setConfirmDelete] = useState(false)
	const [confirmReset, setConfirmReset] = useState(false)

	const handleDelete = useCallback(() => {
		deleteActor.mutate(agent.id, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId/agents', params: { workspaceId } })
			},
		})
	}, [agent.id, deleteActor, navigate, workspaceId])

	const handleReset = useCallback(() => {
		resetActor.mutate(agent.id, {
			onSuccess: () => {
				setConfirmReset(false)
			},
		})
	}, [agent.id, resetActor])

	const headerActions = useMemo(() => {
		if (agent.isSystem) {
			return confirmReset ? (
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">Reset this agent to defaults?</span>
					<Button size="sm" onClick={handleReset} disabled={resetActor.isPending}>
						{resetActor.isPending ? 'Resetting...' : 'Confirm'}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
						Cancel
					</Button>
				</div>
			) : (
				<Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
					<RotateCcw size={14} />
					Reset to default
				</Button>
			)
		}
		return confirmDelete ? (
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
				aria-label="Delete agent"
			>
				<Trash2 size={15} />
			</Button>
		)
	}, [
		agent.isSystem,
		confirmDelete,
		confirmReset,
		handleDelete,
		handleReset,
		deleteActor.isPending,
		resetActor.isPending,
	])

	const handleUpdateName = useCallback(
		(name: string) => {
			updateActor.mutate({ id: agent.id, data: { name } })
		},
		[agent.id, updateActor],
	)

	const handleUpdateDescription = useCallback(
		(description: string) => {
			updateActor.mutate({ id: agent.id, data: { description } })
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
			<PageHeader actions={headerActions} />
			<AgentDocumentView
				agent={agent}
				workspaceId={workspaceId}
				events={agentEvents}
				activeSessions={activeSessions}
				recentSessions={recentSessions}
				hasMoreSessions={hasMoreSessions}
				isLoadingMoreSessions={isLoadingMoreSessions}
				onLoadMoreSessions={() => fetchNextPage()}
				onUpdateName={handleUpdateName}
				onUpdateDescription={handleUpdateDescription}
				onUpdateSystemPrompt={handleUpdateSystemPrompt}
				onUpdateLlmProvider={handleUpdateLlmProvider}
				onUpdateLlmConfig={handleUpdateLlmConfig}
				onUpdateTools={handleUpdateTools}
				onUpdateMemory={handleUpdateMemory}
				onRun={() =>
					run.mutate(
						{ id: agent.id },
						{ onError: () => toast.error(`Couldn't start ${agent.name}`) },
					)
				}
				onNewConversation={() =>
					openWithContext([{ kind: 'agent', id: agent.id, name: agent.name }])
				}
				onPause={() =>
					pause.mutate(agent.id, {
						onError: () => toast.error(`Couldn't pause ${agent.name}`),
					})
				}
				isRunPending={run.isPending}
				isPausePending={pause.isPending}
				isManaged={isManaged}
				onForkPackage={() => setForkOpen(true)}
				managedPackageName={installRecord?.packageName}
			/>
			{isManaged && installRecord && (
				<ForkDialog
					open={forkOpen}
					onOpenChange={setForkOpen}
					workspaceId={workspaceId}
					installedPackageId={installRecord.id}
					packageName={installRecord.packageName}
					installedVersion={installRecord.installedVersion}
					pendingVersion={installRecord.hasUpdate ? installRecord.availableVersion : null}
				/>
			)}
		</>
	)
}
