import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useActor } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useDeleteObject, useUpdateObject } from '@/hooks/use-objects'
import { useObjectRelationships } from '@/hooks/use-relationships'
import type { ActorResponse, EventResponse, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, Copy, MoreHorizontal, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ActivityItem } from '../activity/activity-item'
import { PageHeader } from '../layout/page-header'
import { ActorAvatar } from '../shared/actor-avatar'
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { MarkdownContent } from '../shared/markdown-content'
import { RelativeTime } from '../shared/relative-time'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { LinkedObjects } from './linked-objects'
import { MetadataProperties } from './metadata-properties'

interface ObjectDocumentViewProps {
	object: ObjectResponse
	workspaceId: string
	statuses: string[]
	creator?: ActorResponse
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
	events?: EventResponse[]
	onUpdateTitle: (title: string) => void
	onUpdateContent: (content: string) => void
	onUpdateStatus: (status: string) => void
	onDelete: () => void
	isDeleting?: boolean
}

export function ObjectDocumentView({
	object,
	statuses,
	creator,
	relationships,
	events,
	onUpdateTitle,
	onUpdateContent,
	onUpdateStatus,
	onDelete,
	isDeleting = false,
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

	// Bet metrics from metadata
	const meta = object.metadata as Record<string, unknown> | null
	const betMetrics =
		object.type === 'bet' && meta
			? {
					investment: typeof meta.investment === 'number' ? meta.investment : null,
					duration: typeof meta.duration === 'string' ? meta.duration : null,
					target: typeof meta.target === 'number' ? meta.target : null,
					progress: typeof meta.progress === 'number' ? meta.progress : null,
					daysLeft: typeof meta.days_left === 'number' ? meta.days_left : null,
				}
			: null
	const hasBetMetrics =
		betMetrics &&
		(betMetrics.investment !== null ||
			betMetrics.duration !== null ||
			betMetrics.progress !== null ||
			betMetrics.daysLeft !== null)

	return (
		<div className="max-w-3xl mx-auto">
			{/* Decision banner for proposed bets */}
			{object.type === 'bet' && object.status === 'proposed' && (
				<div className="flex items-center justify-between px-4 py-3 rounded-lg border border-warning/40 bg-warning/10 mb-6">
					<span className="text-sm font-medium text-warning">This bet needs your decision</span>
					<div className="flex gap-2">
						<Button size="sm" onClick={() => onUpdateStatus('active')}>
							Accept
						</Button>
						<Button size="sm" variant="outline" onClick={() => onUpdateStatus('failed')}>
							Reject
						</Button>
					</div>
				</div>
			)}

			{/* Title */}
			<Input
				type="text"
				value={titleDraft}
				onChange={(e) => setTitleDraft(e.target.value)}
				onBlur={handleTitleBlur}
				onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
				placeholder="Untitled"
				className="w-full text-2xl font-semibold tracking-tight bg-transparent border-none outline-none text-foreground mb-2 h-auto p-0 focus:outline-none"
			/>

			{/* Metadata badges row */}
			<div className="flex flex-wrap items-center gap-2 mb-6">
				<TypeBadge type={object.type} />
				{statuses.length > 0 ? (
					<StatusSelect current={object.status} options={statuses} onChange={handleStatusChange} />
				) : (
					<StatusBadge status={object.status} />
				)}
				{object.activeSessionId && <AgentWorkingBadge />}
				{creator && (
					<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
						<ActorAvatar name={creator.name} type={creator.type} size="sm" />
						{creator.name}
					</span>
				)}
				<RelativeTime date={object.createdAt} className="text-[11px] text-muted-foreground" />
			</div>

			{/* Properties */}
			<div className="mb-6">
				<MetadataProperties object={object} />
			</div>

			{/* Content */}
			<div className="mb-8">
				<MarkdownContent content={object.content ?? ''} onChange={handleContentChange} editable />
			</div>

			{/* Bet metrics table */}
			{hasBetMetrics && betMetrics && (
				<div className="mb-8 rounded-lg border border-border overflow-hidden">
					<table className="w-full text-sm">
						<tbody>
							{betMetrics.investment !== null && (
								<tr className="border-b border-border">
									<td className="px-4 py-2.5 text-muted-foreground w-36">Investment</td>
									<td className="px-4 py-2.5 font-medium">
										${betMetrics.investment.toLocaleString()}
									</td>
								</tr>
							)}
							{betMetrics.duration && (
								<tr className="border-b border-border">
									<td className="px-4 py-2.5 text-muted-foreground">Duration</td>
									<td className="px-4 py-2.5 font-medium">{betMetrics.duration}</td>
								</tr>
							)}
							{betMetrics.progress !== null && betMetrics.target !== null && (
								<tr className="border-b border-border">
									<td className="px-4 py-2.5 text-muted-foreground">Progress</td>
									<td className="px-4 py-2.5">
										<div className="flex items-center gap-3">
											<span className="font-medium text-accent">
												{betMetrics.progress}/{betMetrics.target}
											</span>
											<div className="w-20 h-1.5 bg-border rounded-full overflow-hidden">
												<div
													className="h-full bg-accent rounded-full"
													style={{
														width: `${Math.min(100, Math.round((betMetrics.progress / (betMetrics.target as number)) * 100))}%`,
													}}
												/>
											</div>
											<span className="text-xs text-muted-foreground">
												{Math.round((betMetrics.progress / (betMetrics.target as number)) * 100)}%
											</span>
										</div>
									</td>
								</tr>
							)}
							{betMetrics.daysLeft !== null && (
								<tr>
									<td className="px-4 py-2.5 text-muted-foreground">Remaining</td>
									<td className="px-4 py-2.5 font-medium">{betMetrics.daysLeft} days</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}

			{/* Linked objects */}
			{relationships && (
				<div className="border-t border-border pt-6 mb-8">
					<LinkedObjects
						objectId={object.id}
						objectType={object.type}
						asSource={relationships.asSource}
						asTarget={relationships.asTarget}
					/>
				</div>
			)}

			{/* Activity trail */}
			{events && events.length > 0 && (
				<div className="border-t border-border pt-6">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
						Activity
					</h3>
					<div className="space-y-2">
						{events.map((event) => (
							<ActivityItem key={event.id} event={event} compact />
						))}
					</div>
				</div>
			)}
		</div>
	)
}

export function ObjectDocument({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const { data: creator } = useActor(object.createdBy)
	const { data: relationships } = useObjectRelationships(workspaceId, object.id)
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

	const handleDelete = useCallback(() => {
		deleteObject.mutate(object.id, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId', params: { workspaceId } })
			},
		})
	}, [object.id, deleteObject, navigate, workspaceId])

	const [confirmDelete, setConfirmDelete] = useState(false)
	const [copied, setCopied] = useState<'link' | 'content' | null>(null)

	const handleCopy = (type: 'link' | 'content') => {
		const text =
			type === 'link'
				? window.location.href
				: [object.title, object.content].filter(Boolean).join('\n\n')
		navigator.clipboard.writeText(text)
		setCopied(type)
		setTimeout(() => setCopied(null), 1500)
	}

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
					className="text-muted-foreground hover:text-error"
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2 className="h-4 w-4" />
					<span className="sr-only">Delete</span>
				</Button>
			),
		[confirmDelete, handleDelete, deleteObject.isPending, object.type],
	)

	const copyMenu = (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" className="text-muted-foreground">
					<MoreHorizontal className="h-4 w-4" />
					<span className="sr-only">More options</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => handleCopy('link')}>
					{copied === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
					Copy link
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => handleCopy('content')}>
					{copied === 'content' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
					Copy content
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)

	return (
		<>
			<PageHeader
				title={object.title ?? undefined}
				actions={
					<div className="flex items-center gap-1">
						{copyMenu}
						{deleteActions}
					</div>
				}
			/>
			<ObjectDocumentView
				object={object}
				workspaceId={workspaceId}
				statuses={statuses}
				creator={creator}
				relationships={relationships}
				events={events}
				onUpdateTitle={handleUpdateTitle}
				onUpdateContent={handleUpdateContent}
				onUpdateStatus={handleUpdateStatus}
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
