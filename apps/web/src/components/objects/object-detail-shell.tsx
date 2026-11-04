import { CommentInput } from '@/components/activity/comment-input'
import { AgentComposer } from '@/components/agents/agent-composer'
import type { TagInputHandle } from '@/components/chat/tag-input'
import { PageHeader } from '@/components/layout/page-header'
import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useActor, useActors } from '@/hooks/use-actors'
import { useIsMobile } from '@/hooks/use-mobile'
import { useNotifications } from '@/hooks/use-notifications'
import { useObjectFlow } from '@/hooks/use-object-flow'
import { useDeleteObject, useObjectGraph, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useScrollToTopEmitter } from '@/hooks/use-scroll-to-top-emitter'
import { useSession } from '@/hooks/use-sessions'
import { useStar } from '@/hooks/use-star'
import { useUsageState } from '@/hooks/use-usage-state'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { deriveSidebarViewport, trackSidebarToggle } from '@/lib/analytics'
import type { DisplaySettingsBody, ObjectResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { typeLabel } from '@/lib/constants'
import type { ObjectDetailTab } from '@/lib/object-detail-tab'
import { isUpdatedBucket } from '@/lib/objects-updated-buckets'
import { useWorkspace } from '@/lib/workspace-context'
import { CHROME_KEY } from '@maskin/shared'
import { useNavigate } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ObjectAskBanner } from './object-ask-banner'
import { ObjectDetailBody } from './object-detail-body'
import { getAsk } from './object-detail-fixtures'
import {
	ObjectDetailBarActions,
	ObjectDetailIdentity,
	ObjectDetailPills,
} from './object-detail-header'
import { DeleteConfirmDialog } from './object-document'
import { ObjectPropertiesSidebar } from './object-properties-sidebar'
import { Origin } from './origin'
import { PropertiesSidebarProvider, SIDEBAR_WIDTH } from './properties-sidebar-provider'
import { RelatedTab } from './related-tab'
import { resolveRelatedRows } from './related-tab-utils'
import { TimelineTab } from './timeline-tab'

const TAB_TRIGGER_CLASS =
	'rounded-none border-b-2 border-transparent px-0 pt-2 pb-3 text-[15px] font-semibold text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none'

function TabCount({ count }: { count: number }) {
	if (count <= 0) return null
	return <span className="ml-1.5 text-[15px] font-medium text-muted-foreground">{count}</span>
}

/**
 * v16: one composer at a time. `Comment` is the item's own comment input
 * (/ commands, @ mentions); `Message <agent>` is the shared Composer through the
 * agent's chat. The switch only appears when the item has an agent to message:
 * its owner when that is an agent, else the agent working on it right now.
 */
function ItemComposer({
	object,
	workspaceId,
	focusRef,
	focusOnMountRef,
	mode,
	onModeChange,
}: {
	object: ObjectResponse
	workspaceId: string
	focusRef: React.RefObject<TagInputHandle | null>
	/** Set by "Answer it" from another tab: the tab content mounts a render later, so the
	 *  comment input is focused here, once it exists. */
	focusOnMountRef: React.MutableRefObject<boolean>
	mode: 'comment' | 'message'
	onModeChange: (mode: 'comment' | 'message') => void
}) {
	const isMobile = useIsMobile()
	const { data: actors } = useActors(workspaceId)
	const { data: session } = useSession(object.activeSessionId, workspaceId)
	const ownerAgent = actors?.find((a) => a.id === object.driver && a.type === 'agent')
	const workingAgent = actors?.find((a) => a.id === session?.actorId && a.type === 'agent')
	const agentId = (ownerAgent ?? workingAgent)?.id ?? ''
	const { data: agent } = useActor(agentId)
	const canMessage = Boolean(agent)

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on mount and on a mode swap, which is when the comment input is (re)created.
	useEffect(() => {
		if (mode !== 'comment' || !focusOnMountRef.current) return
		focusOnMountRef.current = false
		focusRef.current?.focus()
	}, [mode])

	return (
		<div className="flex flex-col gap-2">
			{canMessage && agent && (
				<Tabs value={mode} onValueChange={(v) => onModeChange(v as 'comment' | 'message')}>
					<TabsList variant="segmented" aria-label="Composer">
						<TabsTrigger value="comment">Comment</TabsTrigger>
						<TabsTrigger value="message">Message {agent.name}</TabsTrigger>
					</TabsList>
				</Tabs>
			)}
			{canMessage && agent && mode === 'message' ? (
				<AgentComposer agent={agent} />
			) : (
				<CommentInput
					workspaceId={workspaceId}
					objectId={object.id}
					focusRef={focusRef}
					variant="bar"
					// The full prompt wraps to three lines in a 375px bar, so the
					// phone gets the short form.
					placeholder={isMobile ? 'Comment…' : 'Comment — / commands, @ mentions'}
				/>
			)}
		</div>
	)
}

export function ObjectDetailShell({
	object,
	tab: controlledTab,
	onTabChange,
	focusCommentId,
}: {
	object: ObjectResponse
	/** The open tab, when the route owns it (the `tab` search param). Without it the shell keeps its own. */
	tab?: ObjectDetailTab
	onTabChange?: (tab: ObjectDetailTab) => void
	/** Event id from the route's `?comment=`, handed to the timeline to scroll to. */
	focusCommentId?: number
}) {
	const { workspaceId, workspace } = useWorkspace()
	const [ownTab, setOwnTab] = useState<ObjectDetailTab>('overview')
	// When the route owns the tab, a missing `?tab=` means Overview — never the
	// last tab this shell instance showed for a different item.
	const tab = controlledTab ?? (onTabChange ? 'overview' : ownTab)
	const changeTab = useCallback(
		(next: ObjectDetailTab) => {
			setOwnTab(next)
			onTabChange?.(next)
		},
		[onTabChange],
	)
	// A linked comment lives in the timeline, so land on the Activity tab for it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new `?comment=` should switch tabs, not a manual tab change.
	useEffect(() => {
		if (focusCommentId != null) changeTab('activity')
	}, [focusCommentId])
	const [composerMode, setComposerMode] = useState<'comment' | 'message'>('comment')
	const flow = useObjectFlow(workspaceId, object.id)
	const navigate = useNavigate()
	const isMobile = useIsMobile()
	const updateObject = useUpdateObject(workspaceId)
	const { toggle: toggleStarKeyboard } = useStar(object.id)
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

	const activityCount = graph?.events?.length ?? 0

	// The ask banner prefers the live needs_input notification targeting this
	// object; `metadata._ask` stays as the fallback for seeded/fixture rows.
	// An ask only belongs to the reader when it's explicitly targeted at them —
	// otherwise the object may be waiting on another actor (e.g. an @mentioned
	// agent) and rendering the banner here would show "waiting for you" with no
	// answerable action attached. The same cache also drives the D4 verb swap on
	// the shared New button, so this list is sorted oldest-first and both
	// surfaces read the same pick and re-render together when SSE flushes.
	const { data: needsInputNotifications } = useNotifications(workspaceId, { type: 'needs_input' })
	const currentActorId = getStoredActor()?.id
	const pendingAsks = useMemo(
		() =>
			(needsInputNotifications ?? [])
				.filter(
					(n) =>
						n.objectId === object.id &&
						n.status === 'pending' &&
						n.targetActorId === currentActorId,
				)
				.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')),
		[needsInputNotifications, object.id, currentActorId],
	)
	const liveAsk = pendingAsks[0]
	const askActor = liveAsk?.sourceActorId
		? actors?.find((a) => a.id === liveAsk.sourceActorId)
		: undefined
	const askText = liveAsk ? (liveAsk.content ?? liveAsk.title) : getAsk(object)

	// D6 credits chip predicate — workspace-scoped selector reacts to SSE
	// invalidation on session lifecycle events (see `sse-invalidation.ts`).
	const { credits_state } = useUsageState(workspaceId)

	// D4: whole button disabled at 60% opacity when the object is
	// non-editable. `archived` bets are the only observable read-only state
	// the current object schema carries — the field is otherwise mutable.
	const isReadOnly = object.status === 'archived'

	// Memoised so the published crumb keeps a stable identity across renders.
	// Three levels (v16): Items › <flow, else the item's type> › <title>.
	const crumb = useMemo(
		() => ({
			parentLabel: 'Items',
			parentTo: '/$workspaceId/objects',
			parentParams: { workspaceId },
			middle: flow
				? {
						label: flow.name,
						to: '/$workspaceId/loops/$loopId',
						params: { workspaceId, loopId: flow.id },
					}
				: { label: typeLabel(object.type) },
			label: object.title ?? 'Untitled',
		}),
		[workspaceId, object.title, object.type, flow],
	)

	const answerRef = useRef<TagInputHandle>(null)
	// The composer is pinned under every tab. Answering still opens the Activity tab
	// (the ask lives on the timeline) and focuses the comment input; when the Message
	// switch hides it, it is focused once the mode swap re-creates it.
	const focusAfterTabRef = useRef(false)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const confirmedDeleteRef = useRef(false)

	// D4: focus the composer at the oldest pending ask on the timeline —
	// mirrors the ObjectAskBanner's Answer-it button, so both entry points
	// commit to the same answer surface. Kept off `pendingAsks` (not
	// `liveAsk`) so the reference is stable across renders that don't change
	// the pick.
	const handleAnswerLatestAsk = useCallback(() => {
		if (composerMode === 'comment') {
			// The composer is pinned under every tab, so it is already mounted.
			answerRef.current?.focus()
			if (tab !== 'activity') changeTab('activity')
			return
		}
		focusAfterTabRef.current = true
		setComposerMode('comment')
		changeTab('activity')
	}, [tab, composerMode, changeTab])

	// D4 verb-swap override published to the shared New button. `useMemo` on
	// the notification cache — automatic re-render when SSE flushes new asks.
	const newMenuPrimaryOverride = useMemo(() => {
		if (!liveAsk) return undefined
		return {
			label: 'Answer this ask',
			ariaLabel: 'Answer the pending ask on this item',
			title: 'Answer this ask — jump to the composer at the pending ask',
			icon: <Pencil aria-hidden className="size-[13px]" />,
			onClick: handleAnswerLatestAsk,
			disabled: isReadOnly,
		}
	}, [liveAsk, handleAnswerLatestAsk, isReadOnly])

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

	// ⌘⇧\ toggles the properties drawer. It was ⌘I until the document editor
	// claimed ⌘I for italic. Shares `handleToggleSidebar` with the header
	// button so both entry points flow through the same mobile-vs-persisted
	// branch, and both are observable to the `sidebar_toggle` effect below.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			// Shift makes the backslash a pipe on most layouts — accept both.
			// `!altKey` for the same reason the nav chord needs it: AltGr sets
			// `ctrlKey` on Windows, and both characters are AltGr products on the
			// layouts where `\` is not a bare key.
			if (
				!((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === '\\' || e.key === '|'))
			)
				return
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

	// SPEC §D5 keyboard shortcut: `s` toggles star on focused detail. Uses the
	// document listener rather than a per-element handler so a plain-page tab
	// with nothing else focused still triggers, matching the list-row behaviour.
	// Skipped inside editable fields (title, body, composer) so `s` types
	// normally there.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 's' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
			const target = e.target as HTMLElement | null
			if (target) {
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
			}
			e.preventDefault()
			toggleStarKeyboard()
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [toggleStarKeyboard])

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

	// Title and body edits commit through the same `updateObject` mutation as
	// status and owner, and toast on failure for the same reason —
	// `useUpdateObject` rolls its optimistic patch back silently, so without a
	// toast a failed save reads as the text reverting on its own.
	// These return the mutation promise so the editor can reopen with the draft
	// intact when the write fails, rather than dropping the user's text.
	const handleUpdateTitle = useCallback(
		async (title: string) => {
			try {
				await updateObject.mutateAsync({ id: object.id, data: { title } })
			} catch (err) {
				toast.error('Could not save your changes')
				throw err
			}
		},
		[object.id, updateObject],
	)

	const handleUpdateContent = useCallback(
		async (content: string) => {
			try {
				await updateObject.mutateAsync({ id: object.id, data: { content } })
			} catch (err) {
				toast.error('Could not save your changes')
				throw err
			}
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
						attention: prev.attention,
						fresh: prev.fresh,
						starred: prev.starred,
						updated: isUpdatedBucket(prev.updated) ? prev.updated : undefined,
						sort: prev.sort ?? 'updatedAt',
						order: prev.order ?? 'desc',
						q: prev.q,
						groupBy: prev.groupBy ?? 'none',
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
						onDeleteRequest={() => setConfirmDelete(true)}
						onArchiveRequest={object.type === 'bet' ? handleArchive : undefined}
						onTogglePropertiesRequest={handleToggleSidebar}
						propertiesOpen={sidebarExpanded}
					/>
				}
				contentPush={contentPush}
				scrollLocked
				newMenuPrimaryOverride={newMenuPrimaryOverride}
				newMenuDisabled={isReadOnly}
			/>
			<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
				{/* The document owns the only scroll region on this screen, so the
				    bar above stays put and the composer can pin to its bottom. */}
				<div
					ref={scrollRegionRef}
					data-detail-scroll-region
					className="min-h-0 flex-1 overflow-y-auto px-[clamp(14px,3vw,24px)] pt-[clamp(18px,3vw,30px)] lg:px-5"
				>
					{/* `min-h-full` + the spacer below put the composer on the bottom of
					    the viewport while the document is short, without giving up the
					    sticky behaviour once it grows past one screen. One column, left
					    aligned to the 48px page inset from lg. */}
					<div className="mx-auto flex min-h-full w-full min-w-0 max-w-[680px] flex-col lg:mx-0 lg:max-w-none">
						<ObjectDetailIdentity
							object={object}
							statuses={statuses}
							members={members ?? []}
							workspaceId={workspaceId}
							creditsState={credits_state}
							onStatusChange={handleUpdateStatus}
							onDriverChange={handleUpdateDriver}
							onTitleChange={handleUpdateTitle}
							showPills={false}
						/>

						{/* System-written lineage — renders NOTHING when the object has no
						    produced_by ancestor (absence contract). Placed between identity
						    and the ask banner per CPO 2026-09-22 (top-of-page, not
						    right-rail). Depends on the graph query already firing above. */}
						<Origin
							object={object}
							relationships={graph?.relationships ?? []}
							workspaceId={workspaceId}
						/>

						{/* v16: status and owner as the shared pills, under the Origin row. */}
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<ObjectDetailPills
								object={object}
								statuses={statuses}
								members={members ?? []}
								workspaceId={workspaceId}
								creditsState={credits_state}
								onStatusChange={handleUpdateStatus}
								onDriverChange={handleUpdateDriver}
							/>
						</div>

						{/* A working agent shows in the banner, above the tabs; an item
						    nobody is working on has none. */}
						{object.activeSessionId && (
							<div className="mt-4">
								<AgentWorkingBadge
									sessionId={object.activeSessionId}
									workspaceId={workspaceId}
									variant="banner"
								/>
							</div>
						)}

						{askText && (
							<ObjectAskBanner
								question={askText}
								onAnswerClick={handleAnswerLatestAsk}
								actorName={askActor?.name}
								actorId={askActor?.id}
								actorType={askActor?.type}
							/>
						)}

						{/* v16: one column, three tabs. Link / Upload live in Related. */}
						<Tabs
							value={tab}
							onValueChange={(v) => changeTab(v as ObjectDetailTab)}
							className="mt-6 flex min-h-0 flex-1 flex-col"
						>
							<TabsList
								variant="default"
								aria-label="Item sections"
								className="h-auto w-full justify-start gap-6 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 px-1"
							>
								<TabsTrigger value="overview" className={TAB_TRIGGER_CLASS}>
									Overview
								</TabsTrigger>
								<TabsTrigger value="related" className={TAB_TRIGGER_CLASS}>
									Related
									<TabCount count={relatedCount} />
								</TabsTrigger>
								<TabsTrigger value="activity" className={TAB_TRIGGER_CLASS}>
									Activity
									<TabCount count={activityCount} />
								</TabsTrigger>
							</TabsList>

							<TabsContent value="overview" className="mt-0">
								<ObjectDetailBody
									object={object}
									workspaceId={workspaceId}
									onContentChange={handleUpdateContent}
								/>
							</TabsContent>
							<TabsContent value="related" className="mt-0">
								<RelatedTab object={object} />
							</TabsContent>
							<TabsContent value="activity" className="mt-0">
								<TimelineTab object={object} focusCommentId={focusCommentId} />
							</TabsContent>

							<div aria-hidden="true" className="min-h-6 flex-1" />

							{/* v3: the composer is pinned under every tab, not only Activity.
							    The mockup's composer is a single bar — `+`, the field, one
							    action button on one row, with no hint line under it. One
							    composer at a time, switched Comment / Message <agent>. */}
							<div className="sticky bottom-0 z-[6] mt-1.5 bg-gradient-to-b from-transparent via-background via-20% to-background pb-4 pt-[22px]">
								<ItemComposer
									object={object}
									workspaceId={workspaceId}
									focusRef={answerRef}
									focusOnMountRef={focusAfterTabRef}
									mode={composerMode}
									onModeChange={setComposerMode}
								/>
							</div>
						</Tabs>
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
					members={members}
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
