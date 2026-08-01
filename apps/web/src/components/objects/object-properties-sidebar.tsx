import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { SubscribeToggle } from '@/components/shared/subscribe-toggle'
import { Button } from '@/components/ui/button'
import { Sidebar, SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { useActor } from '@/hooks/use-actors'
import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { PanelRight } from 'lucide-react'
import { PropertiesPanel } from './properties-panel'

/**
 * Right-side object detail sidebar. Renders Subscribe + created_by +
 * created_at + updated_at at the top, then the shared `PropertiesPanel`
 * (Metadata + Files). Consumers wrap this in `PropertiesSidebarProvider`,
 * which owns the controlled open state; the ⌘/Ctrl+I shortcut is bound in
 * `ObjectDocument` alongside the header button's toggle callback.
 */
export function ObjectPropertiesSidebar({
	object,
	workspaceId,
	relationships,
}: {
	object: ObjectResponse
	workspaceId: string
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
}) {
	const { data: creator } = useActor(object.createdBy)
	return (
		<Sidebar
			side="right"
			collapsible="icon"
			// `pointer-events-auto` re-enables input handling — the provider
			// wrapper sets `pointer-events-none` so the fixed layer doesn't
			// intercept clicks in the empty right gutter.
			className="pointer-events-auto"
		>
			<SidebarHeader className="flex-row items-center justify-between gap-2 border-b border-border px-3 py-2">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground group-data-[collapsible=icon]:hidden">
					Properties
				</span>
				<CollapseToggle />
			</SidebarHeader>
			<SidebarContent className="min-h-0 flex-1 px-3 py-4 group-data-[collapsible=icon]:hidden">
				<div className="mb-4 flex flex-wrap items-center gap-2">
					<SubscribeToggle
						workspaceId={workspaceId}
						entityType="object"
						entityId={object.id}
						isSubscribed={object.is_subscribed}
					/>
				</div>
				{creator && (
					<div className="mb-2 flex items-center gap-1 text-[11px] text-muted-foreground">
						<ActorAvatar name={creator.name} type={creator.type} size="sm" />
						<span>{creator.name}</span>
					</div>
				)}
				<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
					<RelativeTime date={object.createdAt} />
					{shouldShowUpdatedChip(object.createdAt, object.updatedAt) && (
						<span>
							updated <RelativeTime date={object.updatedAt} />
						</span>
					)}
				</div>
				<PropertiesPanel object={object} workspaceId={workspaceId} relationships={relationships} />
			</SidebarContent>
		</Sidebar>
	)
}

// A rail-friendly toggle in the sidebar header: rendered as a PanelRight icon
// button both when collapsed (rail) and when expanded (header close/toggle).
function CollapseToggle() {
	const { toggleSidebar, state } = useSidebar()
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="h-7 w-7"
			onClick={toggleSidebar}
			aria-label={state === 'expanded' ? 'Collapse properties' : 'Expand properties'}
			aria-expanded={state === 'expanded'}
		>
			<PanelRight size={15} />
		</Button>
	)
}

function shouldShowUpdatedChip(createdAt: string | null, updatedAt: string | null): boolean {
	if (!updatedAt) return false
	if (!createdAt) return true
	const created = Date.parse(createdAt)
	const updated = Date.parse(updatedAt)
	if (!Number.isFinite(created) || !Number.isFinite(updated)) return false
	return updated - created >= 60_000
}
