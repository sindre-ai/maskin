import { Button } from '@/components/ui/button'
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
import type {
	ActorResponse,
	EventResponse,
	MemberResponse,
	ObjectResponse,
	RelationshipResponse,
} from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Check, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ObjectActivity } from '../activity/object-activity'
import { PageHeader } from '../layout/page-header'
import { ActorAvatar } from '../shared/actor-avatar'
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { MarkdownContent } from '../shared/markdown-content'
import { RelativeTime } from '../shared/relative-time'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'
import { LinkedObjects } from './linked-objects'
import { MetadataProperties } from './metadata-properties'
import { ObjectActionBanner } from './object-action-banner'

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
		<div className="max-w-3xl mx-auto">
			{/* Action banner for pending decisions */}
			<ObjectActionBanner objectId={object.id} workspaceId={workspaceId} />

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
				{creator && (
					<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
						<ActorAvatar name={creator.name} type={creator.type} size="sm" />
						{creator.name}
					</span>
				)}
				<RelativeTime date={object.createdAt} className="text-[11px] text-muted-foreground" />
			</div>

			{/* Properties */}
			<div className="mb-6 w-fit">
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

			{/* Activity */}
			<ObjectActivity
				workspaceId={workspaceId}
				objectId={object.id}
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
		})
	}, [object.id, deleteObject, navigate, workspaceId])

	const [confirmDelete, setConfirmDelete] = useState(false)

	const deleteActions = useMemo(
		() =>
			confirmDelete ? (
				<div className="flex items-center gap-2">
					<span className="text-xs text-error">Delete this {object.type}?</span>
					<Button
						variant="destructive"
						size="sm"
						onClick={handleDelete}
						disabled={deleteObject.isPending}
					>
						{deleteObject.isPending ? 'Deleting...' : 'Confirm'}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
						Cancel
					</Button>
				</div>
			) : (
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 text-muted-foreground hover:text-error"
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2 size={15} />
				</Button>
			),
		[confirmDelete, handleDelete, deleteObject.isPending, object.type],
	)

	return (
		<>
			<PageHeader actions={deleteActions} />
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
