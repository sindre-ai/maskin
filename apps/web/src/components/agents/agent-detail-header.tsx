import { AgentStatusPill, getPortraitStatus } from '@/components/agents/agent-portrait-card'
import { AgentRunPauseButton } from '@/components/agents/agent-run-pause-button'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useAgentPause, useAgentRun } from '@/hooks/use-actors'
import { deriveAgentStatus, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'
import { toast } from 'sonner'

export function AgentDetailHeader({
	agent,
	sessions,
}: {
	agent: ActorResponse
	sessions: SessionResponse[]
}) {
	const { workspace, workspaceId } = useWorkspace()
	const run = useAgentRun(workspaceId)
	const pause = useAgentPause(workspaceId)

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions), [sessions])
	const sessionStatus = deriveAgentStatus(agent.id, sessionsByAgent)
	const portrait = getPortraitStatus(agent, sessionStatus)
	const isRunning = portrait === 'running'

	const outcome = agent.description?.trim() || 'No outcome set yet'

	return (
		<header className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="md"
					className="h-14 w-14 rounded-2xl text-lg"
					id={agent.id}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
							{agent.name}
						</h1>
						<AgentStatusPill status={portrait} />
						<Select value={workspace.id} disabled>
							<SelectTrigger
								aria-label="Team"
								className="h-7 rounded-full border-dashed px-2.5 text-[11px] font-medium text-muted-foreground"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={workspace.id}>{workspace.name}</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<p className="text-sm text-muted-foreground">
						<span className="text-muted-foreground">Owns one outcome: </span>
						<span className="text-foreground">{outcome}</span>
					</p>
				</div>
				<div className="shrink-0">
					<AgentRunPauseButton
						isActive={isRunning}
						onRun={() =>
							run.mutate(
								{ id: agent.id },
								{ onError: () => toast.error(`Couldn't start ${agent.name}`) },
							)
						}
						onPause={() =>
							pause.mutate(agent.id, {
								onError: () => toast.error(`Couldn't pause ${agent.name}`),
							})
						}
						isRunPending={run.isPending}
						isPausePending={pause.isPending}
						runLabel={portrait === 'paused' ? 'Resume' : 'Run'}
					/>
				</div>
			</div>
		</header>
	)
}
