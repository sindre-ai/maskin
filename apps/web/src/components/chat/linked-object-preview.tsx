import { MarkdownContent } from '@/components/shared/markdown-content'
import { StatusBadge } from '@/components/shared/status-badge'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { extractLinkedObjectIds } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'

// A body this long is shown folded until the reader asks for the rest.
const FOLD_AT = 280

function LinkedObjectPreview({ workspaceId, objectId }: { workspaceId: string; objectId: string }) {
	const { data: object } = useObject(objectId)
	const typeLabel = useObjectTypeLabel()
	const [expanded, setExpanded] = useState(false)

	// Nothing for an object that is missing, in another workspace, or has no
	// text: the link in the message is still there, so the preview only ever adds.
	const body = object?.content?.trim()
	if (!object || object.workspaceId !== workspaceId || !body) return null

	const folded = !expanded && body.length > FOLD_AT
	// Same frame as the draft card, so a draft reads the same whether the agent
	// posted a card or only linked to the task.
	return (
		<div className="mt-2 max-w-[660px] overflow-hidden rounded-xl border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<span className="shrink-0 rounded-md bg-secondary px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
					{typeLabel(object.type)}
				</span>
				<span className="flex-1" />
				<StatusBadge status={object.status} className="shrink-0" />
			</div>
			<div className="px-3 pt-3">
				<p className="text-sm font-semibold leading-snug text-foreground">
					{object.title || 'Untitled'}
				</p>
				<div className={cn('relative mt-2 text-[13.5px]', folded && 'max-h-32 overflow-hidden')}>
					<MarkdownContent content={body} size="sm" />
					{folded ? (
						<div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
					) : null}
				</div>
			</div>
			<div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1 text-xs">
				{body.length > FOLD_AT ? (
					<button
						type="button"
						onClick={() => setExpanded((open) => !open)}
						className="-ml-1 rounded px-1 py-1 text-muted-foreground hover:text-foreground"
					>
						{expanded ? 'Show less' : 'Read all'}
					</button>
				) : (
					<span />
				)}
				<Link
					to="/$workspaceId/objects/$objectId"
					params={{ workspaceId, objectId: object.id }}
					className="inline-flex items-center gap-1 rounded px-1 py-1 text-muted-foreground hover:text-foreground"
				>
					Open
					<ArrowUpRight size={13} aria-hidden />
				</Link>
			</div>
		</div>
	)
}

/**
 * Shows what the objects a message links to say, under the message. Works for
 * any agent and any object type, because it reads the link, not a tool call.
 */
export function LinkedObjectPreviews({
	workspaceId,
	content,
}: {
	workspaceId: string
	content: string
}) {
	const ids = extractLinkedObjectIds(content)
	if (ids.length === 0) return null
	return (
		<>
			{ids.map((id) => (
				<LinkedObjectPreview key={id} workspaceId={workspaceId} objectId={id} />
			))}
		</>
	)
}
