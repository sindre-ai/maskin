import { AgentComposer } from '@/components/agents/agent-composer'
import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { AgentInstructionsSection } from '@/components/agents/agent-instructions-section'
import { AgentLoopsSection } from '@/components/agents/agent-loops-section'
import { getPortraitStatus } from '@/components/agents/agent-portrait-card'
import { AgentRunPauseButton } from '@/components/agents/agent-run-pause-button'
import { AgentSessionsSection } from '@/components/agents/agent-sessions-section'
import { AgentSkillsSection } from '@/components/agents/agent-skills-section'
import { AgentToolsSection } from '@/components/agents/agent-tools-section'
import { AgentUsageBlock } from '@/components/agents/agent-usage-block'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { useAgentPause, useAgentRun, useDeleteActor } from '@/hooks/use-actors'
import { useActorSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

export function AgentDetailView({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: sessions } = useActorSessions(agent.id, workspaceId)
	const run = useAgentRun(workspaceId)
	const pause = useAgentPause(workspaceId)
	const deleteActor = useDeleteActor(workspaceId)
	const navigate = useNavigate()
	const [confirmDelete, setConfirmDelete] = useState(false)

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions ?? []), [sessions])
	const portrait = getPortraitStatus(agent, deriveAgentStatus(agent.id, sessionsByAgent))

	const handleDelete = useCallback(() => {
		deleteActor.mutate(agent.id, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId/agents', params: { workspaceId } })
			},
		})
	}, [agent.id, deleteActor, navigate, workspaceId])

	// The detail bar's one agent-level control is the enable/disable switch
	// (mockup 2313: `adPaused ? "Enable agent" : "Disable agent"`), bordered and
	// amber in both states. Both halves already map onto the app's own calls:
	// `POST /actors/:id/pause` sets agentState `paused` and stops its live
	// sessions, `POST /actors/:id/run` sets it back to `running` and resumes.
	// Starting new work is the composer's job at the foot of the page, exactly
	// as the mockup has it.
	const isDisabled = portrait === 'paused'
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
				pause.mutate(agent.id, { onError: () => toast.error(`Couldn't disable ${agent.name}`) })
			}
			isRunPending={run.isPending}
			isPausePending={pause.isPending}
			runLabel="Enable agent"
			pauseLabel="Disable agent"
			tone="warning"
			density="nav"
		/>
	)

	// System agents cannot be removed — the same guard the old detail document
	// used (agent-document.tsx) and that the backend still enforces on
	// DELETE /api/actors/:id. For a workspace-authored agent, the trash icon
	// sits next to the enable/disable switch; clicking it swaps in an inline
	// "Delete this agent?" confirm rather than a dialog, matching the trigger
	// detail's ghost-icon action (routes/.../triggers/$triggerId.tsx).
	const actions = (
		<div className="flex items-center gap-2">
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
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 text-muted-foreground hover:text-error"
						onClick={() => setConfirmDelete(true)}
						aria-label="Delete agent"
					>
						<Trash2 size={15} />
					</Button>
				))}
		</div>
	)

	return (
		<>
			{/* `Agents › {name}` in the compact detail bar, not a nav-row <h1> — the
			    screen's own identity block below carries the name (mockup 2309–2315). */}
			<PageHeader
				crumb={{
					parentLabel: 'Agents',
					parentTo: '/$workspaceId/agents',
					parentParams: { workspaceId },
					label: agent.name,
				}}
				actions={actions}
			/>
			{/* Order is what the agent *is*, then what it did, then how it is
			    configured: identity → usage → sessions → loops → instructions →
			    skills → tools (mockup 2442–2490). */}
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<AgentDetailHeader agent={agent} portrait={portrait} />
				<AgentUsageBlock agent={agent} workspaceId={workspaceId} />
				<AgentSessionsSection agent={agent} />
				<AgentLoopsSection agent={agent} />
				<AgentInstructionsSection agent={agent} />
				<AgentSkillsSection agent={agent} />
				<AgentToolsSection agent={agent} />
				<AgentComposer agent={agent} />
			</div>
		</>
	)
}
