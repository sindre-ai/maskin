import { AgentStatusPill, type PortraitStatus } from '@/components/agents/agent-portrait-card'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

export function AgentDetailHeader({
	agent,
	portrait,
}: {
	agent: ActorResponse
	/** Derived once by the detail view, which also owns the run/pause action it
	 *  publishes to the nav row (mockup 2351). */
	portrait: PortraitStatus
}) {
	const { workspace } = useWorkspace()

	const outcome = agent.description?.trim() || 'No outcome set yet'

	return (
		<header className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				{/* 56px, 16px radius, solid identity plate (mockup 2318). */}
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="xl"
					tone="strong"
					className="size-14 rounded-2xl text-[22px] font-bold"
					id={agent.id}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="truncate text-[clamp(19px,2.1vw,22px)] font-bold tracking-[-0.02em] text-foreground">
							{agent.name}
						</h1>
						{/* The bare coloured word — no dot, no plate. v2 dropped both here
						    because the name already carries the eye and the identity row
						    should read as one line of text (mockup 2321). */}
						<span className="text-[11px]">
							<AgentStatusPill status={portrait} variant="bare" />
						</span>
						<Select value={workspace.id} disabled>
							<SelectTrigger
								aria-label="Team"
								className="h-[22px] gap-1.5 rounded-full border-dashed bg-muted/40 px-2.5 py-0 text-[11px] font-semibold text-muted-foreground"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={workspace.id}>{workspace.name}</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<p className="text-[13px] text-muted-foreground">
						Owns one outcome: <span className="text-muted-foreground">{outcome}</span>
					</p>
				</div>
			</div>
		</header>
	)
}
