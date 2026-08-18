import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useSidebar } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { type ActiveAgent, useActiveAgents } from '@/hooks/use-active-agents'
import { trackNavItemClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'

// How many avatars the stack shows before collapsing the rest into a +N tile.
const AVATAR_LIMIT = 4

interface ActivitySummary {
	// One entry per distinct agent with at least one live session.
	agents: ActiveAgent[]
	sessionCount: number
}

// `useActiveAgents` returns one row per live session, so an agent running three
// sessions appears three times. The card counts agents in the stack and sessions
// in the sub-line, matching the mockup's `workingIds` / `liveTotal` split.
function summarize(rows: ActiveAgent[]): ActivitySummary {
	const byActor = new Map<string, ActiveAgent>()
	for (const row of rows) {
		if (!byActor.has(row.actorId)) byActor.set(row.actorId, row)
	}
	return { agents: [...byActor.values()], sessionCount: rows.length }
}

function sessionsLabel(count: number): string {
	if (count === 0) return 'nothing running'
	return `${count} ${count === 1 ? 'session' : 'sessions'} running`
}

/**
 * The sidebar's "agents working" card — mockup lines 93–101.
 *
 * One compact card, not a list: a pulsing live dot, a stack of the agents that
 * currently hold a live session, the working/idle word, and a sessions count.
 * The whole card navigates to Agents, which is how the v2 shell reaches that
 * page at all — Agents is not a sidebar nav entry.
 */
export function SidebarActivity({ workspaceId }: { workspaceId: string }) {
	const { agents: rows, isLoading, isError } = useActiveAgents(workspaceId)
	const { setOpenMobile } = useSidebar()

	if (isError) return null
	if (isLoading) return <SidebarActivityLoading />

	const { agents, sessionCount } = summarize(rows)
	const isWorking = agents.length > 0
	const visible = agents.slice(0, AVATAR_LIMIT)
	const overflow = agents.length - visible.length

	return (
		<>
			<Link
				to="/$workspaceId/agents"
				params={{ workspaceId }}
				title={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} · ${sessionsLabel(sessionCount)}`}
				aria-label="Agents"
				onClick={() => trackNavItemClicked({ item_key: 'agents', source: 'footer' })}
				className="hidden place-items-center py-1 group-data-[collapsible=icon]:grid"
			>
				<span
					aria-hidden="true"
					className={cn(
						'size-[7px] rounded-full',
						isWorking ? 'animate-pulse bg-success' : 'bg-border-strong',
					)}
				/>
			</Link>
			<Link
				to="/$workspaceId/agents"
				params={{ workspaceId }}
				data-testid="sidebar-activity"
				onClick={() => {
					// Agents left the nav list in v2 — this card is its only entry
					// point, so it emits the same `nav_item_clicked` event the nav
					// entry used to, keeping the footer-CTR series continuous.
					trackNavItemClicked({ item_key: 'agents', source: 'footer' })
					setOpenMobile(false)
				}}
				className="block rounded-[10px] border border-border bg-card px-[11px] py-2.5 transition-colors duration-150 hover:border-border-hover group-data-[collapsible=icon]:hidden"
			>
				<div className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className={cn(
							'size-[7px] shrink-0 rounded-full',
							isWorking ? 'animate-pulse bg-success' : 'bg-border-strong',
						)}
					/>
					{visible.length > 0 && (
						<span className="flex shrink-0 items-center">
							{visible.map((agent, i) => (
								<ActorAvatar
									key={agent.actorId}
									id={agent.actorId}
									name={agent.name}
									type={agent.type}
									className={cn('size-[22px] text-[9px] ring-2 ring-card', i > 0 && '-ml-1.5')}
								/>
							))}
							{overflow > 0 && (
								<span
									title={`${overflow} more`}
									className="-ml-1.5 grid size-[22px] place-items-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-card"
								>
									+{overflow}
								</span>
							)}
						</span>
					)}
					<span className="min-w-0 truncate text-xs font-semibold text-foreground">
						{isWorking ? 'working' : 'idle'}
					</span>
				</div>
				<div className="mt-[5px] pl-[15px] text-[11.5px] text-muted-foreground">
					{sessionsLabel(sessionCount)}
				</div>
			</Link>
		</>
	)
}

function SidebarActivityLoading() {
	return (
		<div
			data-testid="sidebar-activity-loading"
			className="rounded-[10px] border border-border bg-card px-[11px] py-2.5 group-data-[collapsible=icon]:hidden"
		>
			<div className="flex items-center gap-2">
				<Skeleton className="size-[7px] rounded-full" />
				<Skeleton className="h-[22px] w-[52px] rounded-full" />
				<Skeleton className="h-3 w-12" />
			</div>
			<Skeleton className="mt-[5px] ml-[15px] h-3 w-24" />
		</div>
	)
}
