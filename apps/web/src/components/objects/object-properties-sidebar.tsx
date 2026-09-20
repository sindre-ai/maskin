import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'

import { Button } from '@/components/ui/button'
import { Sidebar, SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { useActors } from '@/hooks/use-actors'
import { useNotifications } from '@/hooks/use-notifications'
import type { MemberResponse, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { X } from 'lucide-react'
import { MetadataProperties } from './metadata-properties'
import { ObjectFiles } from './object-files'
import { OwnerSelect, StatusSelect } from './property-selects'

/**
 * Right-side object detail sidebar. Fully off-canvas when collapsed — no
 * persistent rail; the PageHeader's own PanelRight button is the collapsed
 * entry point (see `headerActions` in `object-document.tsx`). Expanded, it
 * renders a core-fields summary (driver, status, attention, type, created,
 * updated) reusing the same editable pickers as the hero, then Custom fields
 * / Files sections.
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
	const { data: actors } = useActors(workspaceId)
	const creatorName = actors?.find((a) => a.id === object.createdBy)?.name
	const { data: pendingAsks } = useNotifications(workspaceId, { type: 'needs_input' })
	const needsYou = (pendingAsks ?? []).some(
		(n) => n.objectId === object.id && n.status === 'pending',
	)

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
				<span className="eyebrow">Properties</span>
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
								variant="row"
								compact
							/>
						</CorePropertyRow>
					)}
					<CorePropertyRow label="status">
						{statuses.length > 0 ? (
							<StatusSelect
								current={object.status}
								options={statuses}
								onChange={onUpdateStatus}
								variant="row"
							/>
						) : (
							<StatusBadge status={object.status} />
						)}
					</CorePropertyRow>
					{/* `attention` says who the object is waiting on (mockup `odCore`):
					    amber when it needs the reader, green while an agent has it. */}
					{needsYou ? (
						<CorePropertyRow label="attention">
							<span className="text-[12.5px] font-semibold text-warning">Needs you</span>
						</CorePropertyRow>
					) : object.activeSessionId ? (
						<CorePropertyRow label="attention">
							<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
						</CorePropertyRow>
					) : null}
					<CorePropertyRow label="type">
						<span className="text-[12.5px] font-semibold text-secondary-foreground">
							{object.type}
						</span>
					</CorePropertyRow>
					<CorePropertyRow label="created">
						{/* `<when> · <who>` — the mockup pairs the date with its author. */}
						<span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
							<RelativeTime date={object.createdAt} />
							{creatorName && (
								<>
									<span aria-hidden="true">·</span>
									<span className="truncate">{creatorName}</span>
								</>
							)}
						</span>
					</CorePropertyRow>
					{shouldShowUpdatedChip(object.createdAt, object.updatedAt) && (
						<CorePropertyRow label="updated">
							<RelativeTime
								date={object.updatedAt}
								className="text-[12.5px] font-semibold text-muted-foreground"
							/>
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

// The drawer's mono section markers (mockup 1437, 1479, 1490).
function SectionLabel({ children }: { children: React.ReactNode }) {
	return <h3 className="eyebrow">{children}</h3>
}

// 84px label column, mockup 1383.
function CorePropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2.5 py-1">
			<span className="w-[84px] shrink-0 truncate text-[11.5px] text-muted-foreground">
				{label}
			</span>
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
			className="size-7 text-muted-foreground"
			onClick={toggleSidebar}
			aria-label={state === 'expanded' ? 'Collapse properties' : 'Expand properties'}
			aria-expanded={state === 'expanded'}
		>
			<X size={16} />
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
