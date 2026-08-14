import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { AgentInstructionsSection } from '@/components/agents/agent-instructions-section'
import { AgentSessionsSection } from '@/components/agents/agent-sessions-section'
import { AgentSkillsSection } from '@/components/agents/agent-skills-section'
import { AgentToolsSection } from '@/components/agents/agent-tools-section'
import { AgentUsageBlock } from '@/components/agents/agent-usage-block'
import { PageHeader } from '@/components/layout/page-header'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

export function AgentDetailView({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: sessions } = useWorkspaceSessions(workspaceId, { paged: false })

	return (
		<>
			<PageHeader />
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<AgentDetailHeader agent={agent} sessions={sessions ?? []} />
				<AgentUsageBlock agent={agent} workspaceId={workspaceId} />
				<AgentSessionsSection agent={agent} />
				<AgentSkillsSection agent={agent} />
				<AgentToolsSection agent={agent} />
				<AgentInstructionsSection agent={agent} />
			</div>
		</>
	)
}
