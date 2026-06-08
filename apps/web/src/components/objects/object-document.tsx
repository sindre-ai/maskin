import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useActor } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useDeleteObject, useObjectGraph, useUpdateObject } from '@/hooks/use-objects'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { trackEvent } from '@/lib/analytics'
import type {
	ActorResponse,
	EventResponse,
	MemberResponse,
	ObjectResponse,
	RelationshipResponse,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ObjectActivity } from '../activity/object-activity'
import { PageHeader } from '../layout/page-header'
import { ActorAvatar } from '../shared/actor-avatar'
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { MarkdownContent } from '../shared/markdown-content'
import { RelativeTime } from '../shared/relative-time'
import { SourceBadge } from '../shared/source-badge'
import { StatusBadge } from '../shared/status-badge'
import { SubscribeToggle } from '../shared/subscribe-toggle'
import { TypeBadge } from '../shared/type-badge'
import { AuxiliaryActionMenu } from './auxiliary-action-menu'
import { LinkedObjects } from './linked-objects'
import { MetadataProperties } from './metadata-properties'
import { ObjectFiles } from './object-files'

interface ObjectDocumentViewProps {
	object: ObjectResponse
	workspaceId: string
	statuses: string[]
	creator?: ActorResponse
	members?: MemberResponse[]
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
	connectedObjects?: ObjectResponse[]
	events?: EventResponse[]
	onUpdateTitle: (title: string) => void
	onUpdateContent: (content: string) => void
	onUpdateStatus: (status: string) => void
	onUpdateOwner: (owner: string | null) => void
	onDelete: () => void
	isDeleting?: boolean
	showSaved?: boolean
}

export function ObjectDocumentView({
	object,
	workspaceId,
	statuses,
	creator,
	members,
	relationships,
	connectedObjects,
	events,
	onUpdateTitle,
	onUpdateContent,
	onUpdateStatus,
	onUpdateOwner,
	onDelete,
	isDeleting = false,
	showSaved = false,
}: ObjectDocumentViewProps) {
	const [titleDraft, setTitleDraft] = useState(object.title ?? '')

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

	const handleStatusChange = useCallback(
		(status: string) => {
			onUpdateStatus(status)
		},
		[onUpdateStatus],
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
					className="w-full text-2xl font-bold tracking-tight bg-transparent border-none outline-none text-foreground resize-none overflow-hidden p-0 focus:outline-none"
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

			{/* Metadata badges row */}
			<div className="flex flex-wrap items-center gap-2 mb-6">
				<TypeBadge type={object.type} />
				{object.metadata?.source === 'behavioral' && <SourceBadge source="behavioral" />}
				{statuses.length > 0 ? (
					<StatusSelect current={object.status} options={statuses} onChange={handleStatusChange} />
				) : (
					<StatusBadge status={object.status} />
				)}
				{members && (
					<OwnerSelect
						members={members}
						currentOwnerId={object.owner ?? null}
						onChange={onUpdateOwner}
					/>
				)}
				<SubscribeToggle
					workspaceId={workspaceId}
					entityType="object"
					entityId={object.id}
					isSubscribed={object.is_subscribed}
				/>
				{creator && (
					<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
						<ActorAvatar name={creator.name} type={creator.type} size="sm" />
						{creator.name}
					</span>
				)}
				<RelativeTime date={object.createdAt} className="text-[11px] text-muted-foreground" />
			</div>

			{/* Properties */}
			<div className="mb-6 w-full">
				<MetadataProperties object={object} />
			</div>

			{/* Content */}
			<div className="mb-8">
				<MarkdownContent content={object.content ?? ''} onChange={handleContentChange} editable />
			</div>

			{/* Linked objects */}
			{relationships && (
				<div className="border-t border-border pt-6 mb-8">
					<LinkedObjects
						objectId={object.id}
						objectType={object.type}
						asSource={relationships.asSource}
						asTarget={relationships.asTarget}
						connectedObjects={connectedObjects}
					/>
				</div>
			)}

			{/* Files */}
			<div className="border-t border-border pt-6 mb-8">
				<ObjectFiles
					workspaceId={workspaceId}
					objectId={object.id}
					objectType={object.type}
					relationships={relationships}
				/>
			</div>

			{/* Activity */}
			<ObjectActivity
				workspaceId={workspaceId}
				object={object}
				events={events}
				activeSessionId={object.activeSessionId}
			/>
		</div>
	)
}

export function ObjectDocument({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
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
	const childTasks = useMemo<DeleteDialogChildTask[] | undefined>(() => {
		if (!graph || object.type !== 'bet') return undefined
		const byId = new Map(graph.connected_objects.map((co) => [co.id, co]))
		const out: DeleteDialogChildTask[] = []
		for (const rel of graph.relationships) {
			if (rel.type !== 'breaks_into' || rel.sourceId !== object.id) continue
			const co = byId.get(rel.targetId)
			if (!co || co.type !== 'task') continue
			out.push({ id: co.id, title: co.title, status: co.status, relationshipId: rel.id })
		}
		return out
	}, [graph, object.id, object.type])
	const { data: events } = useEntityEvents(workspaceId, object.id)

	const settings = workspace.settings as Record<string, unknown>
	const statuses = (settings?.statuses as Record<string, string[]> | undefined)?.[object.type] ?? []

	const handleUpdateTitle = useCallback(
		(title: string) => {
			updateObject.mutate({ id: object.id, data: { title } })
		},
		[object.id, updateObject],
	)

	const handleUpdateContent = useCallback(
		(content: string) => {
			updateObject.mutate({ id: object.id, data: { content } })
		},
		[object.id, updateObject],
	)

	const handleUpdateStatus = useCallback(
		(status: string) => {
			updateObject.mutate({ id: object.id, data: { status } })
		},
		[object.id, updateObject],
	)

	const handleUpdateOwner = useCallback(
		(owner: string | null) => {
			updateObject.mutate({ id: object.id, data: { owner } })
		},
		[object.id, updateObject],
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
						owner: prev.owner,
						sort: prev.sort ?? 'createdAt',
						order: prev.order ?? 'desc',
						q: prev.q,
						groupBy: prev.groupBy,
						ids: prev.ids,
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

	// T1 ships the UI shell only — accept the new {deleteTaskIds, detachRelationshipIds}
	// signature but still call the existing single-mutation delete path. T2 will
	// consume the selection to fire cascade deletes + detaches.
	const handleConfirmDelete = useCallback(
		(_selection: { deleteTaskIds: string[]; detachRelationshipIds: string[] }) => {
			confirmedDeleteRef.current = true
			handleDelete()
		},
		[handleDelete],
	)

	const [menuOpen, setMenuOpen] = useState(false)

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

	const menuActions = (
		<AuxiliaryActionMenu
			object={object}
			onDeleteRequest={openDeleteConfirm}
			workspaceId={workspaceId}
			open={menuOpen}
			onOpenChange={setMenuOpen}
		/>
	)

	return (
		<>
			<PageHeader actions={menuActions} />
			<DeleteConfirmDialog
				open={confirmDelete}
				onOpenChange={handleDeleteOpenChange}
				objectType={object.type}
				objectTitle={object.title}
				childTasks={childTasks}
				onConfirm={handleConfirmDelete}
				isPending={deleteObject.isPending}
			/>
			<ObjectDocumentView
				object={object}
				workspaceId={workspaceId}
				statuses={statuses}
				creator={creator}
				members={members}
				relationships={relationships}
				connectedObjects={graph?.connected_objects}
				events={events}
				onUpdateTitle={handleUpdateTitle}
				onUpdateContent={handleUpdateContent}
				onUpdateStatus={handleUpdateStatus}
				onUpdateOwner={handleUpdateOwner}
				onDelete={handleDelete}
				isDeleting={deleteObject.isPending}
			/>
		</>
	)
}

export interface DeleteDialogChildTask {
	id: string
	title: string | null
	status: string
	relationshipId: string
}

export interface DeleteConfirmSelection {
	deleteTaskIds: string[]
	detachRelationshipIds: string[]
}

export function DeleteConfirmDialog({
	open,
	onOpenChange,
	objectType,
	objectTitle,
	childTasks,
	onConfirm,
	isPending,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	objectType: string
	objectTitle: string | null
	childTasks?: DeleteDialogChildTask[]
	onConfirm: (selection: DeleteConfirmSelection) => void
	isPending: boolean
}) {
	const isBet = objectType === 'bet'
	const tasks = useMemo<DeleteDialogChildTask[]>(
		() => (isBet ? (childTasks ?? []) : []),
		[isBet, childTasks],
	)
	const hasCascade = isBet && tasks.length > 0
	// All-done bets flip the default to detach (every checkbox starts OFF).
	const startChecked = !(hasCascade && tasks.every((t) => t.status === 'done'))

	const [selected, setSelected] = useState<Set<string>>(() => new Set())
	// Re-seed selection whenever the dialog opens or the task set changes —
	// stale state between two different bets would otherwise leak across opens.
	useEffect(() => {
		if (!open) return
		setSelected(new Set(hasCascade && startChecked ? tasks.map((t) => t.id) : []))
	}, [open, hasCascade, startChecked, tasks])

	const toggle = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}, [])

	const detachAll = useCallback(() => setSelected(new Set()), [])

	const selectedCount = selected.size
	const keptCount = tasks.length - selectedCount

	const handleConfirm = () => {
		if (!hasCascade) {
			onConfirm({ deleteTaskIds: [], detachRelationshipIds: [] })
			return
		}
		const deleteTaskIds: string[] = []
		const detachRelationshipIds: string[] = []
		for (const t of tasks) {
			if (selected.has(t.id)) deleteTaskIds.push(t.id)
			else detachRelationshipIds.push(t.relationshipId)
		}
		onConfirm({ deleteTaskIds, detachRelationshipIds })
	}

	const simpleDescription = objectTitle
		? `This will permanently delete the ${objectType} '${objectTitle}'. This can't be undone.`
		: `This will permanently delete this ${objectType}. This can't be undone.`

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent
				className={cn('flex flex-col', hasCascade ? 'sm:max-w-[520px]' : 'sm:max-w-sm')}
			>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>
						{hasCascade
							? objectTitle
								? `Delete '${objectTitle}'?`
								: 'Delete this bet?'
							: `Delete this ${objectType}?`}
					</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						{hasCascade
							? 'Choose which child tasks to delete along with this bet. Unchecked tasks will be detached and kept.'
							: simpleDescription}
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				{hasCascade && (
					<div className="max-h-[220px] overflow-y-auto rounded-md border border-border">
						<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 text-sm">
							<span className="text-muted-foreground">
								{selectedCount} of {tasks.length} will be deleted
							</span>
							<button
								type="button"
								onClick={detachAll}
								className="text-xs text-primary hover:underline"
							>
								Detach all instead
							</button>
						</div>
						<ul>
							{tasks.map((t) => {
								const checked = selected.has(t.id)
								return (
									<li
										key={t.id}
										className={cn(
											'border-b border-border last:border-b-0',
											!checked && 'bg-muted/30',
										)}
									>
										<label
											htmlFor={`delete-task-${t.id}`}
											className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2"
										>
											<Checkbox
												id={`delete-task-${t.id}`}
												checked={checked}
												onCheckedChange={() => toggle(t.id)}
												disabled={isPending}
											/>
											<span
												className={cn(
													'flex-1 break-words text-sm',
													!checked && 'text-muted-foreground line-through',
												)}
											>
												{t.title ?? 'Untitled task'}
											</span>
											<StatusPill status={t.status} />
										</label>
									</li>
								)
							})}
						</ul>
					</div>
				)}

				<ResponsiveDialogFooter className="gap-2 pb-[max(env(safe-area-inset-bottom),0px)] sm:gap-0">
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
						autoFocus
					>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
						{hasCascade
							? `Delete bet · ${selectedCount} deleted · ${keptCount} kept`
							: isPending
								? 'Deleting...'
								: 'Delete'}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

function StatusPill({ status }: { status: string }) {
	const colors = getStatusColor(status)
	return (
		<span
			className={cn(
				'whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[10px] font-medium',
				colors.bg,
				colors.text,
			)}
		>
			{status.replace(/_/g, ' ')}
		</span>
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
							<ActorAvatar name={current.name} type={current.type} size="sm" />
							{current.name}
						</span>
					) : currentOwnerId ? (
						<span className="italic text-muted-foreground">
							Unknown ({currentOwnerId.slice(0, 8)})
						</span>
					) : (
						<span className="text-muted-foreground">Unassigned</span>
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
