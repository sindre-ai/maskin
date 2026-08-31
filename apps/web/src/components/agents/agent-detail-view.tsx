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
import { useAgentPause, useAgentRun } from '@/hooks/use-actors'
import { useActorSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'
import { toast } from 'sonner'

export function AgentDetailView({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: sessions } = useActorSessions(agent.id, workspaceId)
	const run = useAgentRun(workspaceId)
	const pause = useAgentPause(workspaceId)

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions ?? []), [sessions])
	const portrait = getPortraitStatus(agent, deriveAgentStatus(agent.id, sessionsByAgent))
	const isRunning = portrait === 'running'

	// The agent-level action belongs in the top bar, right-aligned (mockup 2351),
	// not beside the outcome line in the page body.
	const actions = (
		<AgentRunPauseButton
			isActive={isRunning}
			onRun={() =>
				run.mutate({ id: agent.id }, { onError: () => toast.error(`Couldn't start ${agent.name}`) })
			}
			onPause={() =>
				pause.mutate(agent.id, { onError: () => toast.error(`Couldn't pause ${agent.name}`) })
			}
			isRunPending={run.isPending}
			isPausePending={pause.isPending}
			runLabel={portrait === 'paused' ? 'Resume' : 'Run'}
			density="nav"
		/>
	)

	return (
		<>
			<PageHeader title={agent.name} actions={actions} />
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<AgentDetailHeader agent={agent} portrait={portrait} />
				<AgentUsageBlock agent={agent} workspaceId={workspaceId} />
				<AgentSessionsSection agent={agent} />
				<AgentLoopsSection agent={agent} />
				<AgentSkillsSection agent={agent} />
				<AgentToolsSection agent={agent} />
				<AgentInstructionsSection agent={agent} />
				<AgentComposer agent={agent} />
			</div>
		</>
	)
}
