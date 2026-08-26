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
import { toast } from 'sonner'
import { ObjectAskBanner } from './object-ask-banner'
import { ObjectDetailBody } from './object-detail-body'
import { getAsk } from './object-detail-fixtures'
import { ObjectDetailHeader, ObjectDetailIdentity } from './object-detail-header'
import { DeleteConfirmDialog, StickyBetIdentity } from './object-document'
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
	// The shell publishes `scrollLocked`, so the layout's `[data-scroll-root]`
	// is `overflow-hidden` and this region is the only live scroller — the
	// emitter has to be pointed at it explicitly.
	const scrollRegionRef = useRef<HTMLDivElement>(null)
	useScrollToTopEmitter({
		enabled: object.type === 'bet',
		objectSubtype: object.type,
		objectId: object.id,
		scrollRootRef: scrollRegionRef,
	})

	// Bet-scoped sticky nav, carried over from the retired ObjectDocument: once
	// the hero identity row leaves the viewport the shared nav row sprouts a
	// compact title + status chip, so the object's identity is never absent
	// from the screen. `threshold: 0` matches "the hero scrolled off".
	const heroIdentityRef = useRef<HTMLDivElement>(null)
	const [heroVisible, setHeroVisible] = useState(true)
	useEffect(() => {
		if (object.type !== 'bet') return
		const el = heroIdentityRef.current
		if (!el || typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(([entry]) => setHeroVisible(entry.isIntersecting), {
			threshold: 0,
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [object.type])

	const scrollBackToHero = useCallback(() => {
		const target = heroIdentityRef.current
		if (!target) return
		target.scrollIntoView({ behavior: 'smooth', block: 'start' })
		// Focus lands on the hero's status trigger once the smooth scroll
		// settles — the header chip is read-only, editing happens in the hero.
		window.setTimeout(() => {
			document.querySelector<HTMLElement>('[data-hero-status-trigger]')?.focus()
		}, 400)
	}, [])

	const stickyIdentity =
		object.type === 'bet' && !heroVisible ? (
			<StickyBetIdentity
				title={object.title ?? 'Untitled'}
				status={object.status}
				onScrollBack={scrollBackToHero}
			/>
		) : null

	const handleUpdateStatus = useCallback(
		(status: string) => {
			updateObject.mutate(
				{ id: object.id, data: { status } },
				{ onError: () => toast.error('Could not update status') },
			)
		},
		[object.id, updateObject],
	)

	// Archive route shared by the overflow menu: sets status = archived and
	// stamps the prior status for the archived-row treatment downstream.
	const handleArchive = useCallback(() => {
		if (object.type !== 'bet' || object.status === 'archived') return
		updateObject.mutate(
			{
				id: object.id,
				data: { status: 'archived', metadata: { previous_status: object.status } },
			},
			{ onError: () => toast.error('Could not archive this bet') },
		)
	}, [object.id, object.status, object.type, updateObject])

	// Body edits commit through the same `updateObject` mutation as status and
	// owner, and toast on failure for the same reason — `useUpdateObject` rolls
	// its optimistic patch back silently, so without a toast a failed save reads
	// as the text reverting on its own.
	//
	// The title is deliberately not editable here: the v2 shell renders it as a
	// static `h1` under the identity row, so `ObjectDetailIdentity` is mounted
	// without `onTitleChange`.
	const handleUpdateContent = useCallback(
		(content: string) => {
			updateObject.mutate(
				{ id: object.id, data: { content } },
				{ onError: () => toast.error('Could not save your changes') },
			)
		},
		[object.id, updateObject],
	)

	const handleUpdateDriver = useCallback(
		(driver: string | null) => {
			updateObject.mutate(
				{ id: object.id, data: { driver } },
				{ onError: () => toast.error('Could not update owner') },
			)
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
			<PageHeader contentPush={contentPush} stickyIdentity={stickyIdentity} scrollLocked />
			<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
				<ObjectDetailHeader
					object={object}
					workspaceId={workspaceId}
					onDeleteRequest={() => setConfirmDelete(true)}
					onArchiveRequest={object.type === 'bet' ? handleArchive : undefined}
					onTogglePropertiesRequest={handleToggleSidebar}
					propertiesOpen={sidebarExpanded}
				/>

				{/* The document owns the only scroll region on this screen, so the
				    bar above stays put and the composer can pin to its bottom. */}
				<div
					ref={scrollRegionRef}
					data-detail-scroll-region
					className="min-h-0 flex-1 overflow-y-auto"
				>
					<div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col pt-5">
						<div ref={heroIdentityRef}>
							<ObjectDetailIdentity
								object={object}
								statuses={statuses}
								members={members ?? []}
								onStatusChange={handleUpdateStatus}
								onDriverChange={handleUpdateDriver}
							/>
						</div>

						{askText && (
							<ObjectAskBanner
								question={askText}
								onAnswerClick={() => answerRef.current?.focus()}
								actorName={askActor?.name}
								actorId={askActor?.id}
								actorType={askActor?.type}
							/>
						)}

						<ObjectDetailBody
							object={object}
							workspaceId={workspaceId}
							onContentChange={handleUpdateContent}
						/>

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

						<div className="sticky bottom-0 z-[6] bg-gradient-to-b from-transparent via-background to-background pb-4 pt-6">
							{/* The mockup gives the composer one hint slot (1362); on object
							    detail its content names the agent that will read what you
							    write, so it replaces the keyboard hint rather than stacking
							    a second line beneath the card. */}
							<CommentInput
								workspaceId={workspaceId}
								objectId={object.id}
								focusRef={answerRef}
								hint={composerHint || undefined}
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
