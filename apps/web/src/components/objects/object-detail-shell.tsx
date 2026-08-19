import { CommentInput } from '@/components/activity/comment-input'
import { PageHeader } from '@/components/layout/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useActors } from '@/hooks/use-actors'
import { useIsMobile } from '@/hooks/use-mobile'
import { useNotifications } from '@/hooks/use-notifications'
import { useDeleteObject, useObjectGraph, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useScrollToTopEmitter } from '@/hooks/use-scroll-to-top-emitter'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { deriveSidebarViewport, trackSidebarToggle } from '@/lib/analytics'
import type { DisplaySettingsBody, ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { CHROME_KEY } from '@maskin/shared'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ObjectAskBanner } from './object-ask-banner'
import { ObjectDetailBody } from './object-detail-body'
import { getAsk } from './object-detail-fixtures'
import { ObjectDetailBarActions, ObjectDetailIdentity } from './object-detail-header'
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

	// Memoised so the published crumb keeps a stable identity across renders.
	const crumb = useMemo(
		() => ({
			parentLabel: 'Objects',
			parentTo: '/$workspaceId/objects',
			parentParams: { workspaceId },
			label: object.title ?? 'Untitled',
		}),
		[workspaceId, object.title],
	)

	const answerRef = useRef<HTMLTextAreaElement>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const confirmedDeleteRef = useRef(false)

	// Right-side properties drawer (mockup 1371–1499). Desktop pushes the app
	// shell aside via `contentPush`; mobile opens the primitive's Sheet.
	// Open/closed is persisted per actor under the `__chrome__` sentinel row —
	// carried over from the retired ObjectDocument surface along with the
	// ⌘/Ctrl+I chord and the `sidebar_toggle` metric below.
	const settingsQuery = useUserDisplaySettings(workspaceId, CHROME_KEY)
	const upsertSettings = useUpdateUserDisplaySettings(workspaceId)
	const persistedSettings = settingsQuery.data?.settings
	// The drawer rests closed at every viewport until the operator opens it —
	// the shell's shipped default. Once the settings query has fetched, the
	// persisted `objectDetailSidebarCollapsed` bit takes over.
	const sidebarOpen =
		settingsQuery.isFetched && typeof persistedSettings?.objectDetailSidebarCollapsed === 'boolean'
			? !persistedSettings.objectDetailSidebarCollapsed
			: false
	const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false)

	const setSidebarOpen = useCallback(
		(open: boolean) => {
			const nextSettings: DisplaySettingsBody = {
				...(persistedSettings ?? {}),
				objectDetailSidebarCollapsed: !open,
			}
			upsertSettings.mutate({ objectType: CHROME_KEY, settings: nextSettings })
		},
		[persistedSettings, upsertSettings],
	)

	// One toggle callback the header button, the chord, and any programmatic
	// caller share. Mobile flips the transient Sheet; tablet + desktop write
	// the persisted bit.
	const handleToggleSidebar = useCallback(() => {
		if (isMobile) setSidebarOpenMobile((open) => !open)
		else setSidebarOpen(!sidebarOpen)
	}, [isMobile, sidebarOpen, setSidebarOpen])
	const sidebarExpanded = isMobile ? sidebarOpenMobile : sidebarOpen
	const contentPush = !isMobile && sidebarOpen ? SIDEBAR_WIDTH : undefined

	// ⌘/Ctrl+I toggles the right sidebar. Shares `handleToggleSidebar` with the
	// PanelRight header button so both entry points flow through the same
	// mobile-vs-persisted branch, and both are observable to the
	// `sidebar_toggle` analytics effect below.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (!((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I'))) return
			const target = e.target as HTMLElement | null
			if (target) {
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
			}
			e.preventDefault()
			handleToggleSidebar()
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [handleToggleSidebar])

	// Emit `sidebar_toggle` on every transition — covers the PanelRight button,
	// the ⌘/Ctrl+I shortcut, Sheet ESC/overlay close on mobile, and any
	// programmatic toggle. The mount pass is skipped so first paint isn't
	// counted as a toggle. `object_id` is read via a ref so mid-flight route
	// changes don't re-fire the effect just because the id string changed.
	const objectIdRef = useRef(object.id)
	objectIdRef.current = object.id
	const sidebarMountedRef = useRef(false)
	useEffect(() => {
		if (!sidebarMountedRef.current) {
			sidebarMountedRef.current = true
			return
		}
		const width = typeof window !== 'undefined' ? window.innerWidth : 1024
		trackSidebarToggle({
			state: sidebarExpanded ? 'open' : 'closed',
			viewport: deriveSidebarViewport(width),
			object_id: objectIdRef.current,
		})
	}, [sidebarExpanded])

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
			{/* `Objects › <name>` with the drawer toggle and overflow menu on the
			    right — the mockup's whole detail bar (1033–1039). Published to the
			    shared nav so the screen carries one bar, not two. */}
			<PageHeader
				crumb={crumb}
				actions={
					<ObjectDetailBarActions
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
				}
				contentPush={contentPush}
				scrollLocked
			/>
			<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
				{/* The document owns the only scroll region on this screen, so the
				    bar above stays put and the composer can pin to its bottom. */}
				<div className="min-h-0 flex-1 overflow-y-auto px-[clamp(14px,3vw,24px)] pt-[clamp(18px,3vw,30px)]">
					<div className="mx-auto flex w-full min-w-0 max-w-[680px] flex-col">
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

						{/* One Activity rule + a 2-way segmented control (mockup
						    1138–1143): the label is a mono micro-heading, not a
						    section title, and the switch rides the rule's right end. */}
						<Tabs defaultValue="timeline" className="mb-1 mt-11">
							<div className="flex items-center gap-2.5">
								<span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
									Activity
								</span>
								<div className="h-px flex-1 bg-muted" />
								<TabsList variant="segmented" className="shrink-0">
									<TabsTrigger value="timeline">Timeline</TabsTrigger>
									<TabsTrigger value="related">
										Related
										<span className="text-[10.5px] tabular-nums text-border-strong">
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

						{/* The mockup's composer is a single bar — `+`, the field, mic and
						    send on one row (1358–1366), with no hint line under it. */}
						<div className="sticky bottom-0 z-[6] mt-1.5 bg-gradient-to-b from-transparent via-background via-20% to-background pb-4 pt-[22px]">
							<CommentInput
								workspaceId={workspaceId}
								objectId={object.id}
								focusRef={answerRef}
								variant="bar"
								// The full prompt wraps to three lines in a 375px bar, so the
								// phone gets the short form.
								placeholder={isMobile ? 'Comment…' : 'Comment — / commands, @ mentions'}
							/>
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
