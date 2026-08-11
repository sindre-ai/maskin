import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { type ActiveAgent, useActiveAgents } from '@/hooks/use-active-agents'
import { trackSidebarAgentActivityExpanded } from '@/lib/analytics'
import { useState } from 'react'

const VISIBLE_ROW_LIMIT = 5

export function SidebarActivity({ workspaceId }: { workspaceId: string }) {
	const { agents, isLoading, isError } = useActiveAgents(workspaceId)
	const [expanded, setExpanded] = useState(false)

	if (isError) {
		return null
	}

	if (isLoading) {
		return <SidebarActivityLoading />
	}

	if (agents.length === 0) {
		return (
			<SidebarGroup data-testid="sidebar-activity" className="group-data-[collapsible=icon]:hidden">
				<SidebarGroupLabel>Live agents</SidebarGroupLabel>
				<SidebarGroupContent>
					<SidebarMenu>
						<SidebarMenuItem>
							<span className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
								<span className="size-1.5 rounded-full bg-muted-foreground/40" />
								No agents running
							</span>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		)
	}

	const overflow = agents.length > VISIBLE_ROW_LIMIT
	const visibleAgents = expanded || !overflow ? agents : agents.slice(0, VISIBLE_ROW_LIMIT)
	const hiddenCount = agents.length - VISIBLE_ROW_LIMIT

	return (
		<SidebarGroup data-testid="sidebar-activity" className="group-data-[collapsible=icon]:hidden">
			<SidebarGroupLabel>Live agents</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{visibleAgents.map((agent) => (
						<AgentRow key={agent.actorId} agent={agent} />
					))}
					{overflow && (
						<SidebarMenuItem>
							<SidebarMenuButton
								size="sm"
								onClick={() => {
									setExpanded((prev) => {
										if (!prev) trackSidebarAgentActivityExpanded({ workspaceId })
										return !prev
									})
								}}
								aria-expanded={expanded}
								className="text-xs text-muted-foreground"
							>
								<span>{expanded ? 'Show fewer' : `+${hiddenCount} more`}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					)}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	)
}

function AgentRow({ agent }: { agent: ActiveAgent }) {
	return (
		<SidebarMenuItem>
			<div
				className="flex items-center gap-2 px-2 py-1.5 text-xs"
				data-testid="sidebar-activity-row"
			>
				<span
					className="size-1.5 shrink-0 rounded-full bg-success animate-pulse"
					aria-hidden="true"
				/>
				<span className="truncate font-medium text-foreground">{agent.name}</span>
				{agent.currentActivity && (
					<span className="truncate text-muted-foreground">{agent.currentActivity}</span>
				)}
			</div>
		</SidebarMenuItem>
	)
}

function SidebarActivityLoading() {
	return (
		<SidebarGroup
			data-testid="sidebar-activity-loading"
			className="group-data-[collapsible=icon]:hidden"
		>
			<SidebarGroupLabel>Live agents</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{Array.from({ length: 3 }).map((_, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are static
						<SidebarMenuItem key={i}>
							<div className="flex items-center gap-2 px-2 py-1.5">
								<Skeleton className="size-1.5 rounded-full" />
								<Skeleton className="h-3 w-24" />
							</div>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	)
}
