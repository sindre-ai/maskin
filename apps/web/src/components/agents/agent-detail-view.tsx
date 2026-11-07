import { AgentAccessSection } from '@/components/agents/agent-access-section'
import { AgentCallButton } from '@/components/agents/agent-call-button'
import { AgentComposer } from '@/components/agents/agent-composer'
import { AgentComputerSection } from '@/components/agents/agent-computer-section'
import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { AgentDrivingSection } from '@/components/agents/agent-driving-section'
import { AgentExtensionsSection } from '@/components/agents/agent-extensions-section'
import { AgentFailedBanner, AgentWorkingNowCard } from '@/components/agents/agent-focus-card'
import { AgentInstructionsSection } from '@/components/agents/agent-instructions-section'
import { getPortraitStatus } from '@/components/agents/agent-portrait-card'
import { AgentRunPauseButton } from '@/components/agents/agent-run-pause-button'
import { AgentSessionsSection } from '@/components/agents/agent-sessions-section'
import { AgentSkillsSection } from '@/components/agents/agent-skills-section'
import { AgentTriggersSection } from '@/components/agents/agent-triggers-section'
import { AgentUsageBlock } from '@/components/agents/agent-usage-block'
import { PageHeader } from '@/components/layout/page-header'
import { EditorBanner } from '@/components/shared/editor-banner'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAgentPause, useAgentRun, useDeleteActor } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useObjectFacets } from '@/hooks/use-objects'
import { useActorSessions } from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import { type AgentTab, DEFAULT_AGENT_TAB, deriveAgentFocus } from '@/lib/agent-detail'
import { deriveAgentStatus, groupSessionsByAgent } from '@/lib/agent-status'
import { type ActorResponse, ApiError } from '@/lib/api'
import { backgroundTitle, buildBackgroundThreads } from '@/lib/session-thread'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

const TAB_TRIGGER_CLASS =
	'rounded-none border-b-2 border-transparent px-0 pt-2.5 pb-[11px] text-[15px] font-semibold leading-snug text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=active]:shadow-none'

export function AgentDetailView({
	agent,
	tab: controlledTab,
	onTabChange,
}: {
	agent: ActorResponse
	/** The open tab, when the route owns it (the `tab` search param). Without it the view keeps its own. */
	tab?: AgentTab
	onTabChange?: (tab: AgentTab) => void
}) {
	const { workspaceId } = useWorkspace()
	const { data: sessions } = useActorSessions(agent.id, workspaceId)
	const { data: triggers } = useTriggers(workspaceId)
	const { data: drivenFacets } = useObjectFacets(workspaceId, { driver: agent.id })
	const run = useAgentRun(workspaceId)
	const pause = useAgentPause(workspaceId)
	const deleteActor = useDeleteActor(workspaceId)
	const canWrite = useCanWrite()
	const navigate = useNavigate()
	const [confirmDelete, setConfirmDelete] = useState(false)
	const [ownTab, setOwnTab] = useState<AgentTab>(DEFAULT_AGENT_TAB)
	// A route that owns the tab (it passes onTabChange) has no ?tab= on the default Setup tab, so an
	// absent value means Setup, never a stale local tab left over from the previous agent.
	const tab = controlledTab ?? (onTabChange ? DEFAULT_AGENT_TAB : ownTab)
	// The run open in the side panel. The banner and the Working-now card open runs too, so
	// the page owns it and hands it to whichever sessions list is on screen.
	const [openSessionId, setOpenSessionId] = useState<string | null>(null)

	const changeTab = useCallback(
		(next: AgentTab) => {
			setOwnTab(next)
			onTabChange?.(next)
		},
		[onTabChange],
	)

	const sessionList = sessions ?? []
	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessionList), [sessionList])
	const portrait = getPortraitStatus(agent, deriveAgentStatus(agent.id, sessionsByAgent))
	const isDisabled = portrait === 'paused'
	const focus = useMemo(() => deriveAgentFocus(sessionList), [sessionList])
	const triggerCount = useMemo(
		() => (triggers ?? []).filter((t) => t.targetActorId === agent.id).length,
		[triggers, agent.id],
	)
	const triggerNames = useMemo(
		() => new Map((triggers ?? []).map((t) => [t.id, t.name])),
		[triggers],
	)

	// A run is opened through its thread (a follow-up carries on in the run it continues).
	// The panel lives in the sessions list, which only the Sessions tab has, so opening a run
	// from the banner brings the person to Sessions first.
	const openRun = useCallback(
		(sessionId: string) => {
			const thread = buildBackgroundThreads(sessionList, agent.name).find((t) =>
				t.sessionIds.includes(sessionId),
			)
			if (!thread) return
			if (tab !== 'sessions') changeTab('sessions')
			setOpenSessionId(thread.id)
		},
		[sessionList, agent.name, tab, changeTab],
	)

	const handleDelete = useCallback(() => {
		// The delete runs on in the background (toast in useDeleteActor), so leave now.
		setConfirmDelete(false)
		deleteActor.mutate({ id: agent.id, name: agent.name })
		navigate({ to: '/$workspaceId/agents', params: { workspaceId } })
	}, [agent.id, agent.name, deleteActor, navigate, workspaceId])

	// Message hands the person to the agent's chat and its own composer.
	const message = useCallback(
		() =>
			navigate({
				to: '/$workspaceId/chats/new',
				params: { workspaceId },
				search: { agentId: agent.id, agentName: agent.name },
			}),
		[navigate, workspaceId, agent.id, agent.name],
	)

	// The bar's agent-level control is the enable/disable switch, bordered and amber in both
	// states. `POST /actors/:id/pause` sets agentState `paused` and stops its live sessions,
	// `POST /actors/:id/run` sets it back to `running` and resumes.
	const runPause = (
		<AgentRunPauseButton
			isActive={!isDisabled}
			onRun={() =>
				run.mutate(
					{ id: agent.id },
					{ onError: () => toast.error(`Couldn't enable ${agent.name}`) },
				)
			}
			onPause={() =>
				pause.mutate(agent.id, {
					onError: (err) =>
						toast.error(err instanceof ApiError ? err.message : `Couldn't disable ${agent.name}`),
				})
			}
			isRunPending={run.isPending}
			isPausePending={pause.isPending}
			runLabel="Enable agent"
			pauseLabel="Disable agent"
			tone="warning"
			density="nav"
		/>
	)

	// System agents cannot be removed — the backend enforces it on DELETE /api/actors/:id too.
	// The trash icon swaps in an inline "Delete this agent?" confirm rather than a dialog.
	const actions = (
		<div className="flex items-center gap-2">
			<ViewerTooltip>
				<Button
					size="sm"
					className="h-8 rounded-full px-4 text-[13px] font-semibold"
					disabled={!canWrite}
					onClick={message}
				>
					Message
				</Button>
			</ViewerTooltip>
			<AgentCallButton agent={agent} variant="thread" />
			{runPause}
			{!agent.isSystem &&
				(confirmDelete ? (
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
					<ViewerTooltip>
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-muted-foreground hover:text-error"
							disabled={!canWrite}
							onClick={() => setConfirmDelete(true)}
							aria-label="Delete agent"
						>
							<Trash2 size={15} />
						</Button>
					</ViewerTooltip>
				))}
		</div>
	)

	const liveSession = focus?.kind === 'working' ? focus.session : null
	const liveTitle = liveSession
		? backgroundTitle(
				liveSession.triggerId ? triggerNames.get(liveSession.triggerId) : undefined,
				liveSession.actionPrompt,
			)
		: ''

	return (
		<>
			{/* `Agents › {name}` in the compact detail bar, with Message, Live and the
			    enable/disable switch at the right. */}
			<PageHeader
				crumb={{
					parentLabel: 'Agents',
					parentTo: '/$workspaceId/agents',
					parentParams: { workspaceId },
					label: agent.name,
				}}
				actions={actions}
			/>
			{/* w-full: a flex item otherwise shrink-wraps to its widest no-wrap text (an agent's
			    description) and overflows a phone screen. Left-aligned, as in v3. */}
			<div className="flex w-full max-w-280 flex-col gap-6">
				<AgentDetailHeader agent={agent} portrait={portrait} />
				{isDisabled ? (
					<EditorBanner tone="info">
						Disabled. Running sessions were held where they stopped. Enable the agent to continue.
					</EditorBanner>
				) : focus?.kind === 'working' && liveSession ? (
					<AgentWorkingNowCard
						session={liveSession}
						title={liveTitle}
						onWatch={() => openRun(liveSession.id)}
						onMessage={message}
					/>
				) : focus?.kind === 'failed' ? (
					<AgentFailedBanner
						agent={agent}
						session={focus.session}
						onSeeLog={() => openRun(focus.session.id)}
					/>
				) : null}

				<Tabs value={tab} onValueChange={(v) => changeTab(v as AgentTab)}>
					<TabsList
						variant="default"
						aria-label="Agent sections"
						className="h-auto w-full justify-start gap-6 overflow-x-auto rounded-none border-b border-border bg-transparent p-0"
					>
						<TabsTrigger value="setup" className={TAB_TRIGGER_CLASS}>
							Setup
						</TabsTrigger>
						<TabsTrigger value="triggers" className={TAB_TRIGGER_CLASS}>
							Triggers
							<TabCount count={triggerCount} />
						</TabsTrigger>
						<TabsTrigger value="items" className={TAB_TRIGGER_CLASS}>
							Items
							<TabCount count={drivenFacets?.total ?? 0} />
						</TabsTrigger>
						<TabsTrigger value="sessions" className={TAB_TRIGGER_CLASS}>
							Sessions
							<TabCount count={sessionList.length} />
						</TabsTrigger>
						<TabsTrigger value="computer" className={TAB_TRIGGER_CLASS}>
							Computer
						</TabsTrigger>
					</TabsList>

					<TabsContent value="setup" className="mt-4 flex flex-col gap-6">
						<AgentInstructionsSection agent={agent} />
						<AgentExtensionsSection agent={agent} />
						<AgentSkillsSection agent={agent} />
						<AgentAccessSection agent={agent} />
						{/* Model and "Reset to defaults" (v3) wait for backend support. */}
						{!agent.isSystem && (
							<SetupDelete
								disabled={!canWrite}
								onDelete={handleDelete}
								pending={deleteActor.isPending}
							/>
						)}
					</TabsContent>
					<TabsContent value="triggers" className="mt-5">
						<AgentTriggersSection agent={agent} />
					</TabsContent>
					<TabsContent value="items" className="mt-5">
						<AgentDrivingSection agent={agent} />
					</TabsContent>
					<TabsContent value="sessions" className="mt-5 flex flex-col gap-6">
						<AgentSessionsSection
							agent={agent}
							openId={openSessionId}
							onOpenIdChange={setOpenSessionId}
						/>
						<AgentUsageBlock agent={agent} workspaceId={workspaceId} />
						<AgentComposer agent={agent} />
					</TabsContent>
					<TabsContent value="computer" className="mt-5">
						<AgentComputerSection agent={agent} />
					</TabsContent>
				</Tabs>
			</div>
		</>
	)
}

/** The Setup tab's danger row: its own inline confirm, apart from the bar's trash icon. */
function SetupDelete({
	disabled,
	pending,
	onDelete,
}: {
	disabled: boolean
	pending: boolean
	onDelete: () => void
}) {
	const [confirming, setConfirming] = useState(false)
	return (
		<section className="flex items-center justify-between gap-3 border-t border-border pt-4">
			<p className="text-[15px] text-muted-foreground">
				{confirming ? 'Remove it for good?' : 'Removes the agent and its setup.'}
			</p>
			{confirming ? (
				<div className="flex items-center gap-2">
					<Button variant="destructive" size="sm" onClick={onDelete} disabled={pending}>
						{pending ? 'Removing...' : 'Remove'}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
						Keep
					</Button>
				</div>
			) : (
				<ViewerTooltip>
					<Button
						variant="outline"
						size="sm"
						className="text-error"
						disabled={disabled}
						onClick={() => setConfirming(true)}
					>
						Delete this agent
					</Button>
				</ViewerTooltip>
			)}
		</section>
	)
}

function TabCount({ count }: { count: number }) {
	if (count <= 0) return null
	return <span className="ml-1.5 text-[15px] font-medium text-muted-foreground">{count}</span>
}
