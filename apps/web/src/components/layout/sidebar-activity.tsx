import { useSidebar } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { useActiveAgents } from '@/hooks/use-active-agents'
import { trackNavItemClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

// The headline is a state, not a tally — the tile already carries the number
// (mockup line 8795). Nothing running is our equivalent of the mockup's
// `sessionsPaused` branch: the row still reads, it just reads as quiet.
export function workingLabel(agentCount: number): string {
	return agentCount > 0 ? 'Agents working' : 'Agents idle'
}

export function sessionsLabel(count: number): string {
	if (count === 0) return 'nothing running'
	return `${count} ${count === 1 ? 'session' : 'sessions'} running`
}

/**
 * The sidebar's agents row — mockup lines 83–89 (rail: 127–130).
 *
 * A bordered count tile carrying a live dot, the working/idle state, and the
 * session total, with a chevron because the whole row navigates to Agents —
 * which is how the v2 shell reaches that page at all, since Agents is not a
 * sidebar nav entry. Collapsed, the tile survives on its own.
 */
export function SidebarActivity({ workspaceId }: { workspaceId: string }) {
	// The tile counts agents, the sub-line counts sessions — the mockup's
	// `railAgentsCount` / `liveTotal` split. `agents` is already one row per
	// distinct agent, so the session total has to come from the hook's own
	// count rather than this list's length.
	const {
		agents,
		activeSessionCount: sessionCount,
		isLoading,
		isError,
	} = useActiveAgents(workspaceId)
	const { setOpenMobile } = useSidebar()

	if (isError) return null
	if (isLoading) return <SidebarActivityLoading />

	const agentCount = agents.length
	const isWorking = agentCount > 0
	const summary = `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'} working · ${sessionsLabel(sessionCount)}`

	return (
		<>
			<Link
				to="/$workspaceId/agents"
				params={{ workspaceId }}
				title={summary}
				aria-label="Agents"
				onClick={() => trackNavItemClicked({ item_key: 'agents', source: 'footer' })}
				className="relative mx-auto hidden size-8 place-items-center rounded-lg transition-colors duration-150 hover:bg-sidebar-accent group-data-[collapsible=icon]:grid"
			>
				<CountTile count={agentCount} />
				{isWorking && <LiveDot className="right-0.5 top-0.5" />}
			</Link>
			<Link
				to="/$workspaceId/agents"
				params={{ workspaceId }}
				data-testid="sidebar-activity"
				title="View all agents"
				onClick={() => {
					// Agents left the nav list in v2 — this row is its only entry
					// point, so it emits the same `nav_item_clicked` event the nav
					// entry used to, keeping the footer-CTR series continuous.
					trackNavItemClicked({ item_key: 'agents', source: 'footer' })
					setOpenMobile(false)
				}}
				className="flex items-center gap-[9px] rounded-lg px-2.5 py-2 transition-colors duration-150 hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden"
			>
				<span className="relative flex-none">
					<CountTile count={agentCount} />
					{isWorking && <LiveDot className="-right-0.5 -top-0.5" />}
				</span>
				<span className="min-w-0 flex-1 leading-[1.25]">
					<span className="block truncate text-xs font-semibold text-sidebar-foreground">
						{workingLabel(agentCount)}
					</span>
					<span className="block truncate text-[10.5px] text-muted-foreground">
						{sessionsLabel(sessionCount)}
					</span>
				</span>
				<ChevronRight aria-hidden="true" className="size-3 flex-none text-border-strong" />
			</Link>
		</>
	)
}

function CountTile({ count }: { count: number }) {
	return (
		<span className="grid size-[22px] place-items-center rounded-full border-[1.5px] border-border-strong text-[10px] font-bold text-secondary-foreground tabular-nums">
			{count}
		</span>
	)
}

// Green, not brand: this reports liveness, and the nav's own brand dot already
// means "unread". Ringed in the sidebar's own fill so it reads as a badge
// sitting on the tile rather than a hole punched through it.
function LiveDot({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				'absolute size-1.5 rounded-full bg-success ring-[1.5px] ring-sidebar',
				className,
			)}
		/>
	)
}

function SidebarActivityLoading() {
	return (
		<div
			data-testid="sidebar-activity-loading"
			className="flex items-center gap-[9px] px-2.5 py-2 group-data-[collapsible=icon]:hidden"
		>
			<Skeleton className="size-[22px] flex-none rounded-full" />
			<span className="min-w-0 flex-1">
				<Skeleton className="h-3 w-24" />
				<Skeleton className="mt-1 h-2.5 w-20" />
			</span>
		</div>
	)
}
