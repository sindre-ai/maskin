import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { Skills } from '@/components/agents/skills'
import { Button } from '@/components/ui/button'
import { useAgentSkillAttachments } from '@/hooks/use-agent-skill-attachments'
import { useSkills } from '@/hooks/use-skills'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'

export function AgentSkillsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: attachments } = useAgentSkillAttachments(agent.id)
	const { data: personalSkills } = useSkills(agent.id, workspaceId)
	const [managing, setManaging] = useState(false)

	const workspaceCount = attachments?.length ?? 0
	const personalCount = personalSkills?.length ?? 0
	const total = workspaceCount + personalCount

	return (
		<section aria-labelledby="agent-skills-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-skills-heading"
				title="Skills"
				note={
					<span
						className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
						aria-label={`${total} skill${total === 1 ? '' : 's'} attached`}
					>
						· {total}
					</span>
				}
				action={
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 shrink-0 px-2 text-xs font-medium"
						aria-pressed={managing}
						onClick={() => setManaging((v) => !v)}
					>
						{managing ? 'Done' : 'Manage'}
					</Button>
				}
			/>
			<div className="rounded-xl border border-border bg-card px-4 py-4">
				<Skills actorId={agent.id} readOnly={!managing} />
			</div>
		</section>
	)
}
