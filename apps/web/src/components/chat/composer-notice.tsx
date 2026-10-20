import type { DirectAgentStatus } from '@/hooks/use-direct-agent-status'
import { Link } from '@tanstack/react-router'

interface ComposerNoticeProps {
	workspaceId: string
	status: DirectAgentStatus
	/** Id the blocked composer points at with aria-describedby. */
	id: string
}

/**
 * Sits directly above the composer in a 1-1 chat. Two states, both wording
 * fixed by design spec v3. "Paused" says nothing about replies on purpose: a
 * message still wakes a paused agent, and the line must stay true if a
 * human-pause control later changes that.
 */
export function ComposerNotice({ workspaceId, status, id }: ComposerNoticeProps) {
	if (!status.state) return null
	return (
		<div
			id={id}
			role="status"
			data-testid="composer-notice"
			className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[11px] border border-ask-border bg-ask-surface px-[11px] py-[9px] text-[11.5px] leading-[1.45] text-warning"
		>
			{status.state === 'not_in_workspace' ? (
				<>
					<span>
						{status.name} isn't in this workspace yet, so it can't reply. A workspace admin needs to
						add it.
					</span>
					<Link
						to="/$workspaceId/agents/$agentId"
						params={{ workspaceId, agentId: status.id }}
						className="font-semibold underline underline-offset-2"
					>
						Open {status.name} →
					</Link>
				</>
			) : (
				<span>{status.name} is paused.</span>
			)}
		</div>
	)
}
