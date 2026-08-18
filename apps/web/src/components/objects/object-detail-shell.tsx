import { CommentInput } from '@/components/activity/comment-input'
import { PageHeader } from '@/components/layout/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useActors } from '@/hooks/use-actors'
import { useIsMobile } from '@/hooks/use-mobile'
import { useNotifications } from '@/hooks/use-notifications'
import { useDeleteObject, useObjectGraph, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useScrollToTopEmitter } from '@/hooks/use-scroll-to-top-emitter'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ObjectAskBanner } from './object-ask-banner'
import { ObjectDetailBody } from './object-detail-body'
import { getAsk } from './object-detail-fixtures'
import { ObjectDetailHeader, ObjectDetailIdentity } from './object-detail-header'
import { DeleteConfirmDialog } from './object-document'
import { ObjectPropertiesSidebar } from './object-properties-sidebar'
import { PropertiesSidebarProvider, SIDEBAR_WIDTH } from './properties-sidebar-provider'
import { RelatedTab } from './related-tab'
import { resolveRelatedRows } from './related-tab-utils'
import { TimelineTab } from './timeline-tab'

export function ObjectDetailShell({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const isMobile = useIsMobile()
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const { data: allObjects } = useObjects(workspaceId)
	// Mockup 1362 `composerHint` — names the agent that will read what you write
	// here. Only rendered when an agent actually drives the object.
	const driverActor = object.driver ? actors?.find((a) => a.id === object.driver) : undefined
	const composerHint =
		driverActor && driverActor.type === 'agent' ? `${driverActor.name} is listening` : null

	const settings = workspace.settings as Record<string, unknown>
	const statuses = (settings?.statuses as Record<string, string[]> | undefined)?.[object.type] ?? []

	// ObjectFiles inside the drawer wants the edges split by direction.
	const sidebarRelationships = useMemo(() => {
		const rels = graph?.relationships ?? []
		return {
			asSource: rels.filter((rel) => rel.sourceId === object.id),
			asTarget: rels.filter((rel) => rel.targetId === object.id),
		}
	}, [graph, object.id])

	// Same resolver the Related tab body uses, so the "(N)" in the trigger and
	// the "Related (N)" heading inside the tab render off the same shape.
	const relatedCount = useMemo(
		() => resolveRelatedRows(graph, allObjects, object.id).length,
		[graph, allObjects, object.id],
	)

	// The ask banner prefers the live needs_input notification targeting this
	// object; `metadata._ask` stays as the fallback for seeded/fixture rows.
	const { data: needsInputNotifications } = useNotifications(workspaceId, { type: 'needs_input' })
	const liveAsk = useMemo(
		() =>
			(needsInputNotifications ?? []).find(
				(n) => n.objectId === object.id && n.status === 'pending',
			),
		[needsInputNotifications, object.id],
	)
	const askActor = liveAsk?.sourceActorId
		? actors?.find((a) => a.id === liveAsk.sourceActorId)
		: undefined
	const askText = liveAsk ? (liveAsk.content ?? liveAsk.title) : getAsk(object)

	const answerRef = useRef<HTMLTextAreaElement>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const confirmedDeleteRef = useRef(false)

	// Right-side properties drawer (mockup 1371–1499). Desktop pushes the app
	// shell aside via `contentPush`; mobile opens the primitive's Sheet.
	const [sidebarOpen, setSidebarOpen] = useState(false)
	const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false)
	const handleToggleSidebar = useCallback(() => {
		if (isMobile) setSidebarOpenMobile((open) => !open)
		else setSidebarOpen((open) => !open)
	}, [isMobile])
	const sidebarExpanded = isMobile ? sidebarOpenMobile : sidebarOpen
	const contentPush = !isMobile && sidebarOpen ? SIDEBAR_WIDTH : undefined

	// Carried over from the retired ObjectDocument surface: the object page
	// used to emit scroll_to_top from its body render path. The shell replaces
	// that body renderer, so the emitter mounts here to keep the telemetry.
	useScrollToTopEmitter({
		enabled: object.type === 'bet',
		objectSubtype: object.type,
		objectId: object.id,
	})

	const handleUpdateStatus = useCallback(
		(status: string) => {
			updateObject.mutate({ id: object.id, data: { status } })
		},
		[object.id, updateObject],
	)

	// Archive route shared by the overflow menu: sets status = archived and
	// stamps the prior status for the archived-row treatment downstream.
	const handleArchive = useCallback(() => {
		if (object.type !== 'bet' || object.status === 'archived') return
		updateObject.mutate({
			id: object.id,
			data: { status: 'archived', metadata: { previous_status: object.status } },
		})
	}, [object.id, object.status, object.type, updateObject])

	const handleUpdateDriver = useCallback(
		(driver: string | null) => {
			updateObject.mutate({ id: object.id, data: { driver } })
		},
		[object.id, updateObject],
	)

	const handleDelete = useCallback(() => {
		deleteObject.mutate(object.id, {
			onSuccess: () => {
				navigate({
					to: '/$workspaceId/objects',
					params: { workspaceId },
					search: (prev) => ({
						type: prev.type,
						status: prev.status,
						driver: prev.driver,
						filterBy: prev.filterBy,
						attention: prev.attention,
						sort: prev.sort ?? 'updatedAt',
						order: prev.order ?? 'desc',
						q: prev.q,
						groupBy: prev.groupBy ?? 'status',
						ids: prev.ids,
						includeArchived: prev.includeArchived,
					}),
				})
			},
			onError: () => {
				confirmedDeleteRef.current = false
			},
		})
	}, [object.id, deleteObject, navigate, workspaceId])

	const handleConfirmDelete = useCallback(() => {
		confirmedDeleteRef.current = true
		handleDelete()
	}, [handleDelete])

	const handleDeleteOpenChange = useCallback((open: boolean) => {
		setConfirmDelete(open)
	}, [])

	return (
		<>
			<PageHeader contentPush={contentPush} scrollLocked />
			<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
				<ObjectDetailHeader
					object={object}
					workspaceId={workspaceId}
					statuses={statuses}
					members={members ?? []}
					onStatusChange={handleUpdateStatus}
					onDriverChange={handleUpdateDriver}
					onDeleteRequest={() => setConfirmDelete(true)}
					onArchiveRequest={object.type === 'bet' ? handleArchive : undefined}
					onTogglePropertiesRequest={handleToggleSidebar}
					propertiesOpen={sidebarExpanded}
				/>

				{/* The document owns the only scroll region on this screen, so the
				    bar above stays put and the composer can pin to its bottom. */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col pt-5">
						<ObjectDetailIdentity
							object={object}
							statuses={statuses}
							members={members ?? []}
							onStatusChange={handleUpdateStatus}
							onDriverChange={handleUpdateDriver}
						/>

						{askText && (
							<ObjectAskBanner
								question={askText}
								onAnswerClick={() => answerRef.current?.focus()}
								actorName={askActor?.name}
								actorId={askActor?.id}
								actorType={askActor?.type}
							/>
						)}

						<ObjectDetailBody object={object} />

						{/* One Activity heading + rule + a 2-way segmented control
						    (mockup 1138–1143). TabsList/TabsTrigger stay at their
						    shadcn defaults per apps/web/CLAUDE.md's no-size-override
						    rule, so the control is taller than the mockup's 28px pair. */}
						<Tabs defaultValue="timeline" className="mt-8">
							<div className="flex items-center gap-2.5">
								<span className="shrink-0 text-sm font-bold text-foreground">Activity</span>
								<div className="h-px flex-1 bg-border" />
								<TabsList className="shrink-0">
									<TabsTrigger value="timeline">Timeline</TabsTrigger>
									<TabsTrigger value="related">
										Related
										<span className="ml-1.5 tabular-nums text-muted-foreground">
											{relatedCount}
										</span>
									</TabsTrigger>
								</TabsList>
							</div>
							<TabsContent value="timeline" className="mt-0">
								<TimelineTab object={object} />
							</TabsContent>
							<TabsContent value="related" className="mt-3">
								<RelatedTab object={object} />
							</TabsContent>
						</Tabs>

						{/* Sticky composer with a gradient mask, mockup 1357. */}
						<div className="sticky bottom-0 z-[6] bg-gradient-to-b from-transparent via-background to-background pb-4 pt-6">
							<CommentInput workspaceId={workspaceId} objectId={object.id} focusRef={answerRef} />
							{composerHint && (
								<p className="mt-1.5 truncate pl-9 text-[11.5px] text-muted-foreground">
									{composerHint}
								</p>
							)}
						</div>
					</div>
				</div>
			</div>

			<PropertiesSidebarProvider
				open={sidebarOpen}
				onOpenChange={setSidebarOpen}
				openMobile={sidebarOpenMobile}
				onOpenMobileChange={setSidebarOpenMobile}
			>
				<ObjectPropertiesSidebar
					object={object}
					workspaceId={workspaceId}
					relationships={sidebarRelationships}
					statuses={statuses}
					members={members}
					onUpdateStatus={handleUpdateStatus}
					onUpdateDriver={handleUpdateDriver}
				/>
			</PropertiesSidebarProvider>

			<DeleteConfirmDialog
				open={confirmDelete}
				onOpenChange={handleDeleteOpenChange}
				objectType={object.type}
				objectTitle={object.title}
				onConfirm={handleConfirmDelete}
				isPending={deleteObject.isPending}
			/>
		</>
	)
}
