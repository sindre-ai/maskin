import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { SubscribeToggle } from '@/components/shared/subscribe-toggle'
import { Button } from '@/components/ui/button'
import { Sidebar, SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import type { MemberResponse, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { PanelRight } from 'lucide-react'
import { MetadataProperties } from './metadata-properties'
import { ObjectFiles } from './object-files'
import { OwnerSelect, StatusSelect } from './property-selects'

/**
 * Right-side object detail sidebar. Fully off-canvas when collapsed — no
 * persistent rail; the PageHeader's own PanelRight button is the collapsed
 * entry point (see `headerActions` in `object-document.tsx`). Expanded, it
 * renders a core-fields summary (driver, status, attention, type, created,
 * updated) reusing the same editable pickers as the hero, then Custom fields
 * / Subscribed / Files sections.
 */
export function ObjectPropertiesSidebar({
	object,
	workspaceId,
	relationships,
	statuses,
	members,
	onUpdateStatus,
	onUpdateDriver,
}: {
	object: ObjectResponse
	workspaceId: string
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
	statuses: string[]
	members?: MemberResponse[]
	onUpdateStatus: (status: string) => void
	onUpdateDriver: (driver: string | null) => void
}) {
	return (
		<Sidebar
			side="right"
			collapsible="offcanvas"
			// `pointer-events-auto` re-enables input handling — the provider
			// wrapper sets `pointer-events-none` so the fixed layer doesn't
			// intercept clicks in the empty right gutter.
			className="pointer-events-auto"
		>
			<SidebarHeader className="flex-row items-center justify-between gap-2 border-b border-border px-3 py-2">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Properties
				</span>
				<CollapseToggle />
			</SidebarHeader>
			<SidebarContent className="min-h-0 flex-1 overflow-y-auto px-3 py-3.5">
				<div className="flex flex-col">
					{members && (
						<CorePropertyRow label="driver">
							<OwnerSelect
								members={members}
								currentOwnerId={object.driver ?? null}
								onChange={onUpdateDriver}
								compact
							/>
						</CorePropertyRow>
					)}
					<CorePropertyRow label="status">
						{statuses.length > 0 ? (
							<StatusSelect current={object.status} options={statuses} onChange={onUpdateStatus} />
						) : (
							<StatusBadge status={object.status} />
						)}
					</CorePropertyRow>
					{object.activeSessionId && (
						<CorePropertyRow label="attention">
							<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
						</CorePropertyRow>
					)}
					<CorePropertyRow label="type">
						<span className="text-xs text-foreground">{object.type}</span>
					</CorePropertyRow>
					<CorePropertyRow label="created">
						<RelativeTime date={object.createdAt} className="text-xs text-foreground" />
					</CorePropertyRow>
					{shouldShowUpdatedChip(object.createdAt, object.updatedAt) && (
						<CorePropertyRow label="updated">
							<RelativeTime date={object.updatedAt} className="text-xs text-foreground" />
						</CorePropertyRow>
					)}
				</div>

				<div className="mt-5 border-t border-border pt-5">
					<SectionLabel>Custom fields</SectionLabel>
					<div className="mt-2">
						<MetadataProperties object={object} />
					</div>
				</div>

				<div className="mt-5 border-t border-border pt-5">
					<SectionLabel>Subscribed</SectionLabel>
					<div className="mt-2">
						<SubscribeToggle
							workspaceId={workspaceId}
							entityType="object"
							entityId={object.id}
							isSubscribed={object.is_subscribed}
						/>
					</div>
				</div>

				<div className="mt-5 border-t border-border pt-5">
					<ObjectFiles
						workspaceId={workspaceId}
						objectId={object.id}
						objectType={object.type}
						relationships={relationships}
					/>
				</div>
			</SidebarContent>
		</Sidebar>
	)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
			{children}
		</h3>
	)
}

function CorePropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2 py-1">
			<span className="w-20 shrink-0 truncate text-xs text-muted-foreground sm:w-28">{label}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	)
}

// A rail-friendly toggle in the sidebar header: PanelRight icon button that
// collapses the sidebar fully off-canvas (no persistent rail).
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
