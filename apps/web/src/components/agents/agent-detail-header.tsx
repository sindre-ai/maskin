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
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="xl"
					className="rounded-2xl"
					id={agent.id}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
							{agent.name}
						</h1>
						{/* Dot form of the single status renderer — it pulses while live
						    (mockup 2360). */}
						<span className="text-[11px]">
							<AgentStatusPill status={portrait} pulse />
						</span>
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
			</div>
		</header>
	)
}
