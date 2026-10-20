import { StatusSelect } from '@/components/objects/property-selects'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import { useSendMessage } from '@/hooks/use-conversation'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject, useUpdateObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { statusLabel } from '@/lib/constants'
import { extractLinkedObjectIds } from '@/lib/linked-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ArrowUpRight } from 'lucide-react'

interface PreviewProps {
	workspaceId: string
	objectId: string
	/** The chat the message is in and the agent that wrote it; together they let a
	 *  status change tell that agent. Without them the card only previews. */
	conversationId?: string
	agentId?: string
}

function LinkedObjectPreview({ workspaceId, objectId, conversationId, agentId }: PreviewProps) {
	const { data: object } = useObject(objectId)
	const { workspace } = useWorkspace()
	const typeLabel = useObjectTypeLabel()
	const update = useUpdateObject(workspaceId)
	const sendMessage = useSendMessage(conversationId ?? '', workspaceId)

	// Nothing for an object that is missing, in another workspace, or has no
	// text: the link in the message is still there, so the preview only ever adds.
	const body = object?.content?.trim()
	if (!object || object.workspaceId !== workspaceId || !body) return null

	// The workspace's own statuses for this object's type, never a fixed list.
	const statuses =
		(workspace.settings as { statuses?: Record<string, string[]> } | undefined)?.statuses?.[
			object.type
		] ?? []
	const canAct = Boolean(conversationId && agentId)
	// The phase after this one in the workspace's own order, if there is one.
	const nextStatus = statuses[statuses.indexOf(object.status) + 1]

	// The agent is always told. The text goes in the message so it can compare it
	// with what the task holds now before it sends anything.
	const moveTo = (status: string) => {
		if (status === object.status) return
		update.mutate(
			{ id: object.id, data: { status } },
			{
				onSuccess: () => {
					if (!conversationId || !agentId) return
					sendMessage.mutate({
						content: `Moved "${object.title || 'Untitled'}" to ${statusLabel(status)}. The text as it stands:\n\n${body
							.split('\n')
							.map((line) => `> ${line}`)
							.join('\n')}`,
						metadata: { mentions: [agentId] },
					})
				},
			},
		)
	}

	return (
		<div className="mt-2 max-w-[660px] overflow-hidden rounded-xl border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<span className="shrink-0 rounded-md bg-secondary px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
					{typeLabel(object.type)}
				</span>
				<span className="flex-1" />
				{canAct && statuses.length > 0 ? (
					<StatusSelect
						current={object.status}
						options={statuses}
						onChange={moveTo}
						variant="chip"
					/>
				) : null}
				<Link
					to="/$workspaceId/objects/$objectId"
					params={{ workspaceId, objectId: object.id }}
					className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					Open
					<ArrowUpRight size={13} aria-hidden />
				</Link>
			</div>
			<div className="px-3 pt-3">
				<p className="text-sm font-semibold leading-snug text-foreground">
					{object.title || 'Untitled'}
				</p>
				{/* Click the text to edit it where it stands; it saves when you click away.
				    A very long text scrolls inside the card instead of being cut off. */}
				<div className="mt-2 max-h-80 overflow-y-auto text-[13.5px]">
					<MarkdownContent
						content={body}
						size="sm"
						editable={canAct}
						editorLabel="Edit the text"
						onChange={async (value) => {
							await update.mutateAsync({ id: object.id, data: { content: value } })
						}}
					/>
				</div>
			</div>
			{canAct && nextStatus ? (
				<div className="flex items-center justify-end px-3 pb-3 pt-1">
					<Button
						type="button"
						size="sm"
						disabled={update.isPending}
						onClick={() => moveTo(nextStatus)}
					>
						Move to {statusLabel(nextStatus)}
						<ArrowRight size={14} aria-hidden />
					</Button>
				</div>
			) : (
				<div className="pb-3" />
			)}
			{update.error ? (
				<p role="alert" className="px-3 pb-2 text-xs text-destructive">
					Could not save: {update.error.message}
				</p>
			) : null}
		</div>
	)
}

/**
 * Shows the objects a message links to as cards: what they say, their status
 * (changeable from the card, with the writing agent told), a button for the
 * next phase, and the text editable in place. Works for any agent and any object
 * type, because it reads the link, not a tool call.
 */
export function LinkedObjectPreviews({
	workspaceId,
	content,
	conversationId,
	agentId,
}: {
	workspaceId: string
	content: string
	conversationId?: string
	agentId?: string
}) {
	const ids = extractLinkedObjectIds(content)
	if (ids.length === 0) return null
	return (
		<>
			{ids.map((id) => (
				<LinkedObjectPreview
					key={id}
					workspaceId={workspaceId}
					objectId={id}
					conversationId={conversationId}
					agentId={agentId}
				/>
			))}
		</>
	)
}
