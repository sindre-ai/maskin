import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
			<SidebarGroup data-testid="sidebar-activity">
				<SidebarGroupLabel>Activity</SidebarGroupLabel>
				<SidebarGroupContent>
					<SidebarMenu>
						<SidebarMenuItem>
							<span className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
								<span className="size-1.5 rounded-full bg-muted-foreground/40" />
								No agents running
							</span>
							<IconModeStack agents={[]} />
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
		<SidebarGroup data-testid="sidebar-activity">
			<SidebarGroupLabel>Activity</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu className="group-data-[collapsible=icon]:hidden">
					{visibleAgents.map((agent) => (
						<AgentRow key={agent.actorId} agent={agent} />
					))}
					{overflow && (
						<SidebarMenuItem>
							<SidebarMenuButton
								size="sm"
								onClick={() => setExpanded((prev) => !prev)}
								aria-expanded={expanded}
								className="text-xs text-muted-foreground"
							>
								<span>{expanded ? 'Show fewer' : `+${hiddenCount} more`}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					)}
				</SidebarMenu>
				<IconModeStack agents={agents} />
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

function IconModeStack({ agents }: { agents: ActiveAgent[] }) {
	return (
		<div
			className="hidden flex-col items-center gap-1.5 py-1 group-data-[collapsible=icon]:flex"
			data-testid="sidebar-activity-icon-stack"
		>
			{agents.length === 0 && (
				<span
					className="size-1.5 rounded-full bg-muted-foreground/40"
					aria-label="No agents running"
				/>
			)}
			{agents.map((agent) => (
				<Popover key={agent.actorId}>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={`${agent.name}${agent.currentActivity ? ` — ${agent.currentActivity}` : ''}`}
							className="size-2 rounded-full bg-success animate-pulse outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
						/>
					</PopoverTrigger>
					<PopoverContent
						side="right"
						align="start"
						sideOffset={8}
						className="w-56 p-3"
						data-testid="sidebar-activity-popover"
					>
						<div className="flex items-center gap-2">
							<span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
							<span className="truncate text-sm font-medium">{agent.name}</span>
						</div>
						{agent.currentActivity && (
							<div className="mt-1 truncate text-xs text-muted-foreground">
								{agent.currentActivity}
							</div>
						)}
					</PopoverContent>
				</Popover>
			))}
		</div>
	)
}

function SidebarActivityLoading() {
	return (
		<SidebarGroup data-testid="sidebar-activity-loading">
			<SidebarGroupLabel>Activity</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu className="group-data-[collapsible=icon]:hidden">
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
