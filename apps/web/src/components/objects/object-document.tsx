import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useActor } from '@/hooks/use-actors'
import { useContentReconcile } from '@/hooks/use-content-reconcile'
import { useEntityEvents } from '@/hooks/use-events'
import {
	useDeleteObject,
	useKnowledgeReferences,
	useObjectGraph,
	useUpdateObject,
	useVerifyObject,
} from '@/hooks/use-objects'
import { useDeleteRelationship } from '@/hooks/use-relationships'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import {
	trackEditorWriteConflictDetected,
	trackEditorWriteConflictResolved,
	trackEvent,
} from '@/lib/analytics'
import type {
	ActorResponse,
	EventResponse,
	MemberResponse,
	ObjectResponse,
	RelationshipResponse,
} from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { classifyBetStatus } from '@/lib/bet-status'
import type { ConflictDetectedPayload, ConflictResolvedPayload } from '@/lib/reconcile/types'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Check, PanelRight, User } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionBanner } from '../activity/action-banner'
import { ObjectActivity } from '../activity/object-activity'
import { PageHeader } from '../layout/page-header'
import { ActorAvatar } from '../shared/actor-avatar'
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { IndicatorBadgeChip } from '../shared/indicator-badge'
import { MarkdownContent } from '../shared/markdown-content'
import { RelativeTime } from '../shared/relative-time'
import { SourceBadge } from '../shared/source-badge'
import { StatusBadge } from '../shared/status-badge'
import { SubscribeToggle } from '../shared/subscribe-toggle'
import { TypeBadge } from '../shared/type-badge'
import { AuxiliaryActionMenu } from './auxiliary-action-menu'
import { LoopCard } from './loop-card'
import { PropertiesDrawer } from './properties-drawer'
import { ReconcileBanner } from './reconcile-banner'
import { ReconcileDiffOverlay } from './reconcile-diff-overlay'
import { ReconcileTakeTheirsConfirm } from './reconcile-take-theirs-confirm'
import { VerifiedChip, isKnowledgeAuthorWrite } from './verified-chip'

interface ObjectDocumentViewProps {
	object: ObjectResponse
	workspaceId: string
	statuses: string[]
	creator?: ActorResponse
	members?: MemberResponse[]
	allRelationships?: RelationshipResponse[]
	connectedObjects?: ObjectResponse[]
	events?: EventResponse[]
	onUpdateTitle: (title: string) => void
	onUpdateContent: (content: string) => void
	onUpdateStatus: (status: string) => void
	// Optional archive route — when provided, picking `archived` in the status
	// picker is dispatched here instead of `onUpdateStatus`, keeping the
	// single-handler contract with the row's Archive menu action.
	onArchive?: () => void
	onUpdateDriver: (driver: string | null) => void
	onDeleteRelationship?: (relationshipId: string) => void
	onDelete: () => void
	onToggleVerified?: (verified: boolean) => void
	isVerifying?: boolean
	isDeleting?: boolean
	showSaved?: boolean
	betStatus?: ReturnType<typeof classifyBetStatus>
	// False only when `object.content` genuinely wasn't fetched (e.g. an MCP
	// `get_objects` response without `include: ['content']`) — as opposed to
	// the object legitimately having no content. Callers that always fetch the
	// full object (the webapp page) never need to set this.
	contentLoaded?: boolean
	// Rendered above the markdown editor; owned by the container so the
	// reconcile banner can share the editor's PATCH path without threading a
	// second mutation through the view.
	reconcileSlot?: ReactNode
}

// Renders "Referenced by N contexts/week" alongside the other prov-row chips
// on knowledge object headers. Hidden when N is 0 (per DoD — the empty state
// stays invisible so the row doesn't grow a permanent "Never referenced"
// footprint). Also hidden while the count is loading or on API failure — the
// chip is decorative, not load-bearing, so it must never block the header
// from rendering.
function KnowledgeReferencesChip({
	workspaceId,
	objectId,
}: {
	workspaceId: string
	objectId: string
}) {
	const { data } = useKnowledgeReferences(workspaceId, objectId)
	const count = data?.unique_contexts ?? 0
	if (count <= 0) return null
	return (
		<span
			className="text-[11px] text-muted-foreground"
			title="Unique bets/tasks/insights that cited this knowledge object in the last 7 days (rolling window)"
		>
			Referenced by {count} {count === 1 ? 'context' : 'contexts'}/week
		</span>
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

export function ObjectDocumentView({
	object,
	workspaceId,
	statuses,
	creator,
	members,
	allRelationships,
	connectedObjects,
	events,
	onUpdateTitle,
	onUpdateContent,
	onUpdateStatus,
	onArchive,
	onUpdateDriver,
	onDeleteRelationship,
	onDelete,
	onToggleVerified,
	isVerifying = false,
	isDeleting = false,
	showSaved = false,
	betStatus,
	contentLoaded = true,
	reconcileSlot,
}: ObjectDocumentViewProps) {
	const [titleDraft, setTitleDraft] = useState(object.title ?? '')
	// Reset the local title draft when navigating to a different object — this
	// component instance is reused across route param changes, so the useState
	// initializer alone would leave the textarea stuck on the previous title.
	const [trackedObjectId, setTrackedObjectId] = useState(object.id)
	if (trackedObjectId !== object.id) {
		setTrackedObjectId(object.id)
		setTitleDraft(object.title ?? '')
	}

	const handleTitleBlur = useCallback(() => {
		if (titleDraft !== object.title) {
			onUpdateTitle(titleDraft)
		}
	}, [titleDraft, object.title, onUpdateTitle])

	const handleContentChange = useCallback(
		(content: string) => {
			onUpdateContent(content)
		},
		[onUpdateContent],
	)

	// One handler, two entry points: the status picker's `archived` option
	// dispatches to the same archive route as the row Archive menu. Falls back
	// to the generic status update if no archive handler was supplied — the
	// dropdown item is still there because the workspace's bet status enum
	// includes `archived`, but without a bet-typed object it just moves the
	// status like any other value.
	const handleStatusChange = useCallback(
		(status: string) => {
			if (status === 'archived' && onArchive && object.type === 'bet') {
				onArchive()
				return
			}
			onUpdateStatus(status)
		},
		[onUpdateStatus, onArchive, object.type],
	)

	return (
		<div className="w-full min-w-0 max-w-3xl mx-auto">
			{/* Title */}
			<div className="flex items-start gap-2 mb-2">
				<textarea
					value={titleDraft}
					onChange={(e) => {
						setTitleDraft(e.target.value)
						e.target.style.height = 'auto'
						e.target.style.height = `${e.target.scrollHeight}px`
					}}
					onBlur={handleTitleBlur}
					onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
					placeholder="Untitled"
					rows={1}
					className="w-full text-2xl font-semibold tracking-[-0.022em] bg-transparent border-none outline-none text-foreground resize-none overflow-hidden p-0 focus:outline-none"
					ref={(el) => {
						if (el) {
							el.style.height = 'auto'
							el.style.height = `${el.scrollHeight}px`
						}
					}}
				/>
				{showSaved && (
					<span className="flex items-center gap-1 text-xs text-muted-foreground mt-1.5">
						<Check size={14} /> Saved
					</span>
				)}
			</div>

			{/* Agent working banner */}
			{object.activeSessionId && (
				<AgentWorkingBadge
					sessionId={object.activeSessionId}
					workspaceId={workspaceId}
					variant="banner"
				/>
			)}

			{object.type === 'loop' && <LoopCard object={object} workspaceId={workspaceId} />}

			{/* Metadata badges row — editable cluster stays inline; provenance
			 * (creator + createdAt) drops to its own row below sm so 375px never
			 * spills into a jagged partial wrap. */}
			<div className="flex flex-wrap items-center gap-2 mb-6">
				<TypeBadge type={object.type} />
				{object.metadata?.source === 'behavioral' && <SourceBadge source="behavioral" />}
				{statuses.length > 0 ? (
					<StatusSelect current={object.status} options={statuses} onChange={handleStatusChange} />
				) : (
					<StatusBadge status={object.status} />
				)}
				{object.type === 'bet' && betStatus && (
					<IndicatorBadgeChip result={betStatus} workspaceId={workspaceId} />
				)}
				{isKnowledgeAuthorWrite(object) && onToggleVerified && (
					<VerifiedChip
						object={object}
						members={members}
						onToggle={onToggleVerified}
						isPending={isVerifying}
					/>
				)}
				{members && (
					<OwnerSelect
						members={members}
						currentOwnerId={object.driver ?? null}
						onChange={onUpdateDriver}
					/>
				)}
				<SubscribeToggle
					workspaceId={workspaceId}
					entityType="object"
					entityId={object.id}
					isSubscribed={object.is_subscribed}
				/>
				<div className="flex basis-full items-center gap-2 sm:basis-auto">
					{creator && (
						<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
							<ActorAvatar name={creator.name} type={creator.type} size="sm" />
							{creator.name}
						</span>
					)}
					<RelativeTime date={object.createdAt} className="text-[11px] text-muted-foreground" />
					{shouldShowUpdatedChip(object.createdAt, object.updatedAt) && (
						<span className="text-[11px] text-muted-foreground">
							updated <RelativeTime date={object.updatedAt} />
						</span>
					)}
					{object.type === 'knowledge' && (
						<KnowledgeReferencesChip workspaceId={workspaceId} objectId={object.id} />
					)}
				</div>
			</div>

			{/* Content — long-form prose caps at 75ch on viewports ≥1280px (AC-U1). */}
			<div className="mb-8 xl:max-w-[75ch]">
				{reconcileSlot}
				{contentLoaded ? (
					<MarkdownContent content={object.content ?? ''} onChange={handleContentChange} editable />
				) : (
					<p className="text-sm text-muted-foreground italic">
						Content not included in this response.
					</p>
				)}
			</div>

			{/* Activity — relationships are projected inline (AC-U11) or rendered
				as a grouped-by-edge-type table (AC-U12) depending on the persisted
				Timeline ↔ Table choice. */}
			<ObjectActivity
				workspaceId={workspaceId}
				object={object}
				events={events}
				relationships={allRelationships}
				connectedObjects={connectedObjects}
				onDeleteRelationship={onDeleteRelationship}
				activeSessionId={object.activeSessionId}
			/>
		</div>
	)
}

export function ObjectDocument({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const updateObject = useUpdateObject(workspaceId)
	const verifyObject = useVerifyObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const deleteRelationship = useDeleteRelationship(workspaceId, object.id)
	const { data: creator } = useActor(object.createdBy)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const relationships = useMemo(() => {
		if (!graph) return undefined
		const asSource: RelationshipResponse[] = []
		const asTarget: RelationshipResponse[] = []
		for (const rel of graph.relationships) {
			if (rel.sourceId === object.id) asSource.push(rel)
			if (rel.targetId === object.id) asTarget.push(rel)
		}
		return { asSource, asTarget }
	}, [graph, object.id])
	// Flat, deduped list for the activity surface (both projection and table
	// view consume the same edge set — AC-U12).
	const allRelationships = useMemo(() => {
		if (!graph) return undefined
		const seen = new Set<string>()
		const list: RelationshipResponse[] = []
		for (const rel of graph.relationships) {
			if (seen.has(rel.id)) continue
			seen.add(rel.id)
			list.push(rel)
		}
		return list
	}, [graph])
	const handleDeleteRelationship = useCallback(
		(relationshipId: string) => {
			deleteRelationship.mutate(relationshipId)
		},
		[deleteRelationship],
	)
	const { data: events } = useEntityEvents(workspaceId, object.id)

	const settings = workspace.settings as Record<string, unknown>
	const statuses = (settings?.statuses as Record<string, string[]> | undefined)?.[object.type] ?? []

	// Bets get a `waiting/progressing/stalled/idle` chip in the header. Classify
	// over child tasks derived from `breaks_into` relationships already loaded
	// by `useObjectGraph` — no extra API call.
	const betStatus = useMemo(() => {
		if (object.type !== 'bet' || !graph) return undefined
		const childTaskIds = new Set<string>()
		for (const rel of graph.relationships) {
			if (rel.type !== 'breaks_into' || rel.sourceId !== object.id) continue
			childTaskIds.add(rel.targetId)
		}
		const childTasks = graph.connected_objects.filter(
			(o) => o.type === 'task' && childTaskIds.has(o.id),
		)
		return classifyBetStatus(object, childTasks)
	}, [object, graph])

	const handleUpdateTitle = useCallback(
		(title: string) => {
			updateObject.mutate({ id: object.id, data: { title } })
		},
		[object.id, updateObject],
	)

	const onConflictDetected = useCallback(
		(payload: ConflictDetectedPayload) => {
			trackEditorWriteConflictDetected({
				object_id: payload.objectId,
				workspace_id: workspaceId,
				actor_id: getStoredActor()?.id ?? '',
				source: 'patch',
			})
		},
		[workspaceId],
	)
	const onConflictResolved = useCallback(
		(payload: ConflictResolvedPayload) => {
			trackEditorWriteConflictResolved({
				object_id: payload.objectId,
				workspace_id: workspaceId,
				actor_id: getStoredActor()?.id ?? '',
				resolution: payload.resolution,
			})
		},
		[workspaceId],
	)
	const reconcile = useContentReconcile({
		object,
		onConflictDetected,
		onConflictResolved,
	})

	const handleUpdateContent = useCallback(
		(content: string) => {
			reconcile.saveContent(content)
		},
		[reconcile],
	)

	const handleUpdateStatus = useCallback(
		(status: string) => {
			updateObject.mutate({ id: object.id, data: { status } })
		},
		[object.id, updateObject],
	)

	// Archive route shared by the row `⋯` menu and the status picker. Sets
	// `status = archived` and stamps the current status onto
	// `metadata.previous_status` so the archived-row treatment (T4) can render
	// "was <prior status>". Server-side metadata is shallow-merged, so
	// `archive_reason` and any other existing keys survive. A hygiene sweep
	// can populate `archive_reason` later; the reason prompt UI is deferred.
	const handleArchive = useCallback(() => {
		if (object.type !== 'bet') return
		if (object.status === 'archived') return
		updateObject.mutate({
			id: object.id,
			data: {
				status: 'archived',
				metadata: { previous_status: object.status },
			},
		})
	}, [object.id, object.status, object.type, updateObject])

	const handleUpdateDriver = useCallback(
		(driver: string | null) => {
			updateObject.mutate({ id: object.id, data: { driver } })
		},
		[object.id, updateObject],
	)

	const handleToggleVerified = useCallback(
		(verified: boolean) => {
			verifyObject.mutate({ id: object.id, verified })
		},
		[object.id, verifyObject],
	)

	const [confirmDelete, setConfirmDelete] = useState(false)
	// Set when the user clicks Delete inside the dialog, so the dismissal that
	// follows (mutation success → navigation, or any close) isn't counted as a
	// cancel. Reset every time the dialog reopens and on mutation error, so a
	// cancel after a failed delete still emits the event.
	const confirmedDeleteRef = useRef(false)

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
						sort: prev.sort ?? 'createdAt',
						order: prev.order ?? 'desc',
						q: prev.q,
						groupBy: prev.groupBy,
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

	const openDeleteConfirm = useCallback(() => {
		confirmedDeleteRef.current = false
		trackEvent('delete_confirmation_shown', {
			object_type: object.type,
			object_id: object.id,
		})
		setConfirmDelete(true)
	}, [object.type, object.id])

	const handleDeleteOpenChange = useCallback(
		(open: boolean) => {
			if (!open && !confirmedDeleteRef.current) {
				trackEvent('delete_confirmation_cancelled', {
					object_type: object.type,
					object_id: object.id,
				})
			}
			setConfirmDelete(open)
		},
		[object.type, object.id],
	)

	const handleConfirmDelete = useCallback(() => {
		confirmedDeleteRef.current = true
		handleDelete()
	}, [handleDelete])

	const [menuOpen, setMenuOpen] = useState(false)
	const [drawerOpen, setDrawerOpen] = useState(false)

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (!((e.metaKey || e.ctrlKey) && e.key === '.')) return
			const target = e.target as HTMLElement | null
			if (target) {
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
			}
			e.preventDefault()
			setMenuOpen(true)
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [])

	const headerActions = (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="h-7 w-7"
				onClick={() => setDrawerOpen((v) => !v)}
				aria-label="Properties"
				aria-expanded={drawerOpen}
			>
				<PanelRight size={15} />
			</Button>
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={openDeleteConfirm}
				onArchiveRequest={handleArchive}
				workspaceId={workspaceId}
				open={menuOpen}
				onOpenChange={setMenuOpen}
			/>
		</>
	)

	return (
		<>
			<PageHeader actions={headerActions} />
			<DeleteConfirmDialog
				open={confirmDelete}
				onOpenChange={handleDeleteOpenChange}
				objectType={object.type}
				objectTitle={object.title}
				onConfirm={handleConfirmDelete}
				isPending={deleteObject.isPending}
			/>
			<ActionBanner events={events} workspaceId={workspaceId} />
			<ObjectDocumentView
				object={object}
				workspaceId={workspaceId}
				statuses={statuses}
				creator={creator}
				members={members}
				allRelationships={allRelationships}
				connectedObjects={graph?.connected_objects}
				events={events}
				onUpdateTitle={handleUpdateTitle}
				onUpdateContent={handleUpdateContent}
				onUpdateStatus={handleUpdateStatus}
				onArchive={handleArchive}
				onUpdateDriver={handleUpdateDriver}
				onDeleteRelationship={handleDeleteRelationship}
				reconcileSlot={
					<>
						<ReconcileBanner
							status={reconcile.status}
							onReview={reconcile.openReview}
							onKeepMine={reconcile.keepMine}
							onTakeTheirs={reconcile.requestTakeTheirs}
						/>
						{reconcile.conflict && (
							<>
								<ReconcileDiffOverlay
									open={reconcile.status === 'reviewing'}
									onOpenChange={(open) => {
										if (!open) reconcile.closeReview()
									}}
									mine={reconcile.conflict.mine}
									theirs={reconcile.conflict.theirs}
									onKeepMine={reconcile.keepMine}
									onTakeTheirs={reconcile.requestTakeTheirs}
									busy={reconcile.status === 'retrying'}
								/>
								<ReconcileTakeTheirsConfirm
									open={reconcile.status === 'confirming_take_theirs'}
									onOpenChange={(open) => {
										if (!open) reconcile.cancelTakeTheirs()
									}}
									onConfirm={reconcile.confirmTakeTheirs}
								/>
							</>
						)}
					</>
				}
				onDelete={handleDelete}
				onToggleVerified={handleToggleVerified}
				isVerifying={verifyObject.isPending}
				isDeleting={deleteObject.isPending}
				betStatus={betStatus}
			/>
			<PropertiesDrawer
				open={drawerOpen}
				onOpenChange={setDrawerOpen}
				object={object}
				workspaceId={workspaceId}
				relationships={relationships}
			/>
		</>
	)
}

export function DeleteConfirmDialog({
	open,
	onOpenChange,
	objectType,
	objectTitle,
	onConfirm,
	isPending,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	objectType: string
	objectTitle: string | null
	onConfirm: () => void
	isPending: boolean
}) {
	const description = objectTitle
		? `This will permanently delete the ${objectType} '${objectTitle}'. This can't be undone.`
		: `This will permanently delete this ${objectType}. This can't be undone.`
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete this {objectType}?</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2 sm:gap-0">
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm} disabled={isPending}>
						{isPending ? 'Deleting...' : 'Delete'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function StatusSelect({
	current,
	options,
	onChange,
}: {
	current: string
	options: string[]
	onChange: (status: string) => void
}) {
	return (
		<Select value={current} onValueChange={onChange}>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((status) => (
					<SelectItem key={status} value={status}>
						{status.replace(/_/g, ' ')}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

const UNASSIGNED_OWNER = '__none__'

function OwnerSelect({
	members,
	currentOwnerId,
	onChange,
}: {
	members: MemberResponse[]
	currentOwnerId: string | null
	onChange: (owner: string | null) => void
}) {
	const current = members.find((m) => m.actorId === currentOwnerId)

	const handleChange = (value: string) => {
		onChange(value === UNASSIGNED_OWNER ? null : value)
	}

	return (
		<Select value={currentOwnerId ?? UNASSIGNED_OWNER} onValueChange={handleChange}>
			<SelectTrigger>
				<SelectValue>
					{current ? (
						<span className="inline-flex items-center gap-1.5">
							{current.type !== 'agent' && <User className="size-3 text-amber-600 shrink-0" />}
							<span className="text-muted-foreground text-[11px]">Driver:</span>
							<ActorAvatar name={current.name} type={current.type} size="sm" />
							{current.name}
						</span>
					) : currentOwnerId ? (
						<span className="italic text-muted-foreground">
							Unknown ({currentOwnerId.slice(0, 8)})
						</span>
					) : (
						<span className="text-muted-foreground">Driver: Unassigned</span>
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={UNASSIGNED_OWNER}>
					<span className="text-muted-foreground">Unassigned</span>
				</SelectItem>
				{members.map((m) => (
					<SelectItem key={m.actorId} value={m.actorId}>
						<span className="inline-flex items-center gap-1.5">
							<ActorAvatar name={m.name} type={m.type} size="sm" />
							{m.name}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
