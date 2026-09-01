import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'

import { Button } from '@/components/ui/button'
import { Sidebar, SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { useActors } from '@/hooks/use-actors'
import { useNotifications } from '@/hooks/use-notifications'
import { useObjectGraph } from '@/hooks/use-objects'
import { useSubscribe, useSubscribers, useUnsubscribe } from '@/hooks/use-subscriptions'
import type { ActorListItem, MemberResponse, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { X } from 'lucide-react'
import { useMemo } from 'react'
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
					<SubscribedSection object={object} workspaceId={workspaceId} />
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

/**
 * SUBSCRIBED (mockup 1470–1482): a header note, then one row per subscriber
 * with the reason they are on it, then the subscribe control. The reason is
 * read off the object itself (driver / author / the viewer), never invented.
 */
function SubscribedSection({
	object,
	workspaceId,
}: {
	object: ObjectResponse
	workspaceId: string
}) {
	const { data: subscribers } = useSubscribers(workspaceId, 'object', object.id)
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const { data: actors } = useActors(workspaceId)
	const subscribe = useSubscribe(workspaceId)
	const unsubscribe = useUnsubscribe(workspaceId)
	const currentActorId = getStoredActor()?.id

	// Everyone who gets timeline updates, in the mockup's order (8394–8400):
	// you, then the driver, then whoever has posted here. The subscriber list
	// alone under-reports it — the driver and the agents posting to the object
	// are on it whether or not they ever pressed Subscribe.
	const rows = useMemo(() => {
		const byId = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) byId.set(actor.id, actor)

		const ordered: string[] = []
		const push = (id: string | null | undefined) => {
			if (!id || ordered.includes(id) || !byId.has(id)) return
			ordered.push(id)
		}

		if (object.is_subscribed) push(currentActorId)
		push(object.driver)
		for (const actor of subscribers?.actors ?? []) push(actor.id)
		for (const event of graph?.events ?? []) {
			if (event.action === 'commented') push(event.actorId)
		}

		return ordered.slice(0, 5).map((id) => byId.get(id) as ActorListItem)
	}, [actors, subscribers, graph, object.is_subscribed, object.driver, currentActorId])

	return (
		<div className="flex flex-col">
			<div className="flex items-center gap-2">
				<SectionLabel>Subscribed</SectionLabel>
				<span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
					{object.is_subscribed ? 'everyone here gets timeline updates' : 'you are not on this one'}
				</span>
			</div>
			{rows.length > 0 && (
				<ul className="mt-2 flex flex-col">
					{rows.map((actor) => (
						<li key={actor.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
							<ActorAvatar
								id={actor.id}
								name={actor.name}
								type={actor.type}
								className="size-[22px] shrink-0 text-[9px]"
							/>
							<span className="min-w-0 flex-1 leading-tight">
								<span className="block truncate text-[12.5px] font-semibold text-foreground">
									{actor.name}
								</span>
								<span className="block truncate text-[10.5px] text-muted-foreground">
									{subscriberReason(actor.id, object, currentActorId)}
								</span>
							</span>
						</li>
					))}
				</ul>
			)}
			{/* A labelled control, not an avatar stack — the rows above already
			    say who is on it (mockup 1445). */}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="mt-2 h-auto self-start rounded-lg px-2.5 py-1.5 text-[11.5px] font-semibold text-muted-foreground"
				disabled={subscribe.isPending || unsubscribe.isPending}
				onClick={() =>
					object.is_subscribed
						? unsubscribe.mutate({ entityType: 'object', entityId: object.id })
						: subscribe.mutate({ entityType: 'object', entityId: object.id })
				}
			>
				{object.is_subscribed ? 'Unsubscribe' : 'Subscribe'}
			</Button>
		</div>
	)
}

/** Why this actor is on the object — the mockup's per-row sub-line. */
function subscriberReason(
	actorId: string,
	object: ObjectResponse,
	currentActorId: string | undefined,
): string {
	if (actorId === currentActorId) return 'you own the outcome'
	if (actorId === object.driver) return 'drives this object'
	if (actorId === object.createdBy) return 'created it'
	return 'posts to this timeline'
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
