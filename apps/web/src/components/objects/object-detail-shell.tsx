import { CommentInput } from '@/components/activity/comment-input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDeleteObject, useObjectGraph, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useScrollToTopEmitter } from '@/hooks/use-scroll-to-top-emitter'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ActivityTab } from './activity-tab'
import { ObjectAskBanner } from './object-ask-banner'
import { ObjectDetailBody } from './object-detail-body'
import { getAsk } from './object-detail-fixtures'
import { ObjectDetailHeader } from './object-detail-header'
import { DeleteConfirmDialog } from './object-document'
import { RelatedTab } from './related-tab'
import { resolveRelatedRows } from './related-tab-utils'
import { TimelineTab } from './timeline-tab'

export function ObjectDetailShell({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const { data: allObjects } = useObjects(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const statuses = (settings?.statuses as Record<string, string[]> | undefined)?.[object.type] ?? []

	// Same resolver the Related tab body uses, so the "(N)" in the trigger and
	// the "Related (N)" heading inside the tab render off the same shape.
	const relatedCount = useMemo(
		() => resolveRelatedRows(graph, allObjects, object.id).length,
		[graph, allObjects, object.id],
	)

	const ask = getAsk(object)
	const answerRef = useRef<HTMLTextAreaElement>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const confirmedDeleteRef = useRef(false)

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

	const handleConfirmDelete = useCallback(() => {
		confirmedDeleteRef.current = true
		handleDelete()
	}, [handleDelete])

	const handleDeleteOpenChange = useCallback((open: boolean) => {
		setConfirmDelete(open)
	}, [])

	return (
		<div className="w-full min-w-0 max-w-3xl mx-auto">
			<ObjectDetailHeader
				object={object}
				workspaceId={workspaceId}
				statuses={statuses}
				members={members ?? []}
				onStatusChange={handleUpdateStatus}
				onDriverChange={handleUpdateDriver}
				onDeleteRequest={() => setConfirmDelete(true)}
				onArchiveRequest={object.type === 'bet' ? handleArchive : undefined}
			/>

			{ask && <ObjectAskBanner question={ask} onAnswerClick={() => answerRef.current?.focus()} />}

			<ObjectDetailBody object={object} />

			<Tabs defaultValue="activity" className="mt-8">
				<TabsList>
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="timeline">Timeline</TabsTrigger>
					<TabsTrigger value="related">
						Related{' '}
						<span className="ml-1 tabular-nums text-muted-foreground">({relatedCount})</span>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="activity" className="mt-4">
					<ActivityTab object={object} />
				</TabsContent>
				<TabsContent value="timeline" className="mt-4">
					<TimelineTab object={object} />
				</TabsContent>
				<TabsContent value="related" className="mt-4">
					<RelatedTab object={object} />
				</TabsContent>
			</Tabs>

			<div className="mt-8 border-t border-border pt-4">
				<CommentInput workspaceId={workspaceId} objectId={object.id} focusRef={answerRef} />
			</div>

			<DeleteConfirmDialog
				open={confirmDelete}
				onOpenChange={handleDeleteOpenChange}
				objectType={object.type}
				objectTitle={object.title}
				onConfirm={handleConfirmDelete}
				isPending={deleteObject.isPending}
			/>
		</div>
	)
}
