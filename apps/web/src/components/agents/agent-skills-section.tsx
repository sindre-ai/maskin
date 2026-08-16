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
		<section
			aria-label="Skills"
			className="overflow-hidden rounded-xl border border-border bg-card"
		>
			<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
				<span className="eyebrow">Skills</span>
				<span
					className="text-[11px] tabular-nums text-muted-foreground"
					aria-label={`${total} skill${total === 1 ? '' : 's'} attached`}
				>
					· {total}
				</span>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="ml-auto h-7 px-2 text-xs font-medium"
					aria-pressed={managing}
					onClick={() => setManaging((v) => !v)}
				>
					{managing ? 'Done' : 'Manage'}
				</Button>
			</div>
			<div className="px-4 py-4">
				<Skills actorId={agent.id} readOnly={!managing} />
			</div>
		</section>
	)
}
