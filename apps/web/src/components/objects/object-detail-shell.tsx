import { CommentInput } from '@/components/activity/comment-input'
import { PageHeader } from '@/components/layout/page-header'
import { AuxiliaryActionMenu } from '@/components/objects/auxiliary-action-menu'
import { ObjectAskBanner } from '@/components/objects/object-ask-banner'
import { ObjectDetailBody } from '@/components/objects/object-detail-body'
import { getAsk } from '@/components/objects/object-detail-fixtures'
import { ObjectDetailHeader } from '@/components/objects/object-detail-header'
import { DeleteConfirmDialog } from '@/components/objects/object-document'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { useCallback, useRef, useState } from 'react'

/**
 * Static object-detail surface: identity row + title, the agent's open-question
 * banner ("Answer it ↓" jumps focus to the composer), the document body with
 * its collapsible folds, and the answer composer. All parts come from the
 * shared component library — no page-local one-offs.
 */
export function ObjectDetailShell({
	object,
	workspaceId,
	statuses,
	members,
	onStatusChange,
	onDriverChange,
	onDelete,
	isDeleting,
}: {
	object: ObjectResponse
	workspaceId: string
	statuses: string[]
	members: MemberResponse[]
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
	onDelete: () => void
	isDeleting: boolean
}) {
	const ask = getAsk(object)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const answerRef = useRef<HTMLTextAreaElement>(null)

	const handleAnswer = useCallback(() => {
		answerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
		answerRef.current?.focus({ preventScroll: true })
	}, [])

	return (
		<>
			<PageHeader
				actions={
					<AuxiliaryActionMenu
						object={object}
						workspaceId={workspaceId}
						statuses={statuses}
						members={members}
						currentDriverId={object.driver}
						onStatusChange={onStatusChange}
						onDriverChange={onDriverChange}
						onDeleteRequest={() => setConfirmDelete(true)}
					/>
				}
			/>
			<DeleteConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				objectType={object.type}
				objectTitle={object.title}
				onConfirm={onDelete}
				isPending={isDeleting}
			/>
			<div className="w-full min-w-0 mx-auto max-w-3xl space-y-5">
				<ObjectDetailHeader
					object={object}
					statuses={statuses}
					members={members}
					onStatusChange={onStatusChange}
					onDriverChange={onDriverChange}
				/>
				{ask && <ObjectAskBanner title={ask.title} sub={ask.sub} onAnswer={handleAnswer} />}
				<ObjectDetailBody object={object} />
				<div className="border-t border-border pt-4">
					<CommentInput workspaceId={workspaceId} objectId={object.id} focusRef={answerRef} />
				</div>
			</div>
		</>
	)
}
