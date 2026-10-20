import { StatusSelect } from '@/components/objects/property-selects'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Switch } from '@/components/ui/switch'
import { useSendMessage } from '@/hooks/use-conversation'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject, useUpdateObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { extractLinkedObjectIds } from '@/lib/linked-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Pencil } from 'lucide-react'
import { useState } from 'react'

// A body this long is shown folded until the reader asks for the rest.
const FOLD_AT = 280

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
	const [expanded, setExpanded] = useState(false)
	const [editing, setEditing] = useState(false)
	const [tellAgent, setTellAgent] = useState(true)

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
	const folded = !editing && !expanded && body.length > FOLD_AT

	// The text goes in the message so the agent can compare it with what the task
	// holds now before it sends anything.
	const moveTo = (status: string) => {
		if (status === object.status) return
		update.mutate(
			{ id: object.id, data: { status } },
			{
				onSuccess: () => {
					if (!tellAgent || !conversationId || !agentId) return
					sendMessage.mutate({
						content: `Moved "${object.title || 'Untitled'}" to ${status.replace(/_/g, ' ')}. The text as it stands:\n\n${body
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
			</div>
			<div className="px-3 pt-3">
				<p className="text-sm font-semibold leading-snug text-foreground">
					{object.title || 'Untitled'}
				</p>
				<div className={cn('relative mt-2 text-[13.5px]', folded && 'max-h-32 overflow-hidden')}>
					<MarkdownContent
						content={body}
						size="sm"
						editable={editing}
						onChange={async (value) => {
							await update.mutateAsync({ id: object.id, data: { content: value } })
							setEditing(false)
						}}
					/>
					{folded ? (
						<div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
					) : null}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 pt-1 text-xs text-muted-foreground">
				{body.length > FOLD_AT && !editing ? (
					<button
						type="button"
						onClick={() => setExpanded((open) => !open)}
						className="-ml-1 rounded px-1 py-1 hover:text-foreground"
					>
						{expanded ? 'Show less' : 'Read all'}
					</button>
				) : null}
				{canAct && !editing ? (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="inline-flex items-center gap-1 rounded px-1 py-1 hover:text-foreground"
					>
						<Pencil size={12} aria-hidden />
						Edit
					</button>
				) : null}
				<span className="flex-1" />
				{canAct ? (
					<label className="inline-flex items-center gap-1.5">
						<Switch
							checked={tellAgent}
							onCheckedChange={setTellAgent}
							aria-label="Tell the agent"
						/>
						Tell the agent
					</label>
				) : null}
				<Link
					to="/$workspaceId/objects/$objectId"
					params={{ workspaceId, objectId: object.id }}
					className="inline-flex items-center gap-1 rounded px-1 py-1 hover:text-foreground"
				>
					Open
					<ArrowUpRight size={13} aria-hidden />
				</Link>
			</div>
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
 * (changeable from the card, with the writing agent told), and an Edit for the
 * text. Works for any agent and any object type, because it reads the link, not
 * a tool call.
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
