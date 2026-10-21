import { StatusSelect } from '@/components/objects/property-selects'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import { Button } from '@/components/ui/button'
import { useSendMessage } from '@/hooks/use-conversation'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject, useUpdateObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { statusLabel } from '@/lib/constants'
import { extractLinkedObjectIds } from '@/lib/linked-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ArrowUpRight, ChevronDown } from 'lucide-react'
import { useState } from 'react'

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
	// Contracted shows the header and title; the text and the next-phase button
	// appear once the top of the card is clicked.
	const [expanded, setExpanded] = useState(false)

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
			{/* The whole top (header and title) toggles the card. The status menu and
			    Open stop the click so they keep doing their own job; the status menu's
			    dropdown is portalled but still bubbles through React, so it is covered too. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard path; its click bubbles here */}
			<div className="cursor-pointer" onClick={() => setExpanded((open) => !open)}>
				<div
					className={cn('flex items-center gap-2 px-3 py-2', expanded && 'border-b border-border')}
				>
					<span className="shrink-0 rounded-md bg-secondary px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
						{typeLabel(object.type)}
					</span>
					<span className="flex-1" />
					{canAct && statuses.length > 0 ? (
						<span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
							<StatusSelect
								current={object.status}
								options={statuses}
								onChange={moveTo}
								variant="chip"
							/>
						</span>
					) : null}
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: object.id }}
						onClick={(e) => e.stopPropagation()}
						className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
					>
						Open
						<ArrowUpRight size={13} aria-hidden />
					</Link>
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expanded ? 'Contract preview' : 'Expand preview'}
						className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:text-foreground"
					>
						<ChevronDown
							size={14}
							aria-hidden
							className={cn('transition-transform', expanded && 'rotate-180')}
						/>
					</button>
				</div>
				<p
					className={cn(
						'px-3 text-sm font-semibold leading-snug text-foreground',
						expanded ? 'pt-3' : 'truncate pb-3 pt-1',
					)}
				>
					{object.title || 'Untitled'}
				</p>
			</div>
			{expanded ? (
				<>
					{object.preview ? (
						<div className="px-3 pt-2">
							<ObjectPreviewMeta preview={object.preview} />
						</div>
					) : null}
					{/* Click the text to edit it where it stands; it saves when you click away.
					    A very long text scrolls inside the card instead of being cut off. */}
					<div className="max-h-80 overflow-y-auto px-3 pt-2 text-[13.5px]">
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
				</>
			) : null}
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
