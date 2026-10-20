import { MarkdownContent } from '@/components/shared/markdown-content'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject } from '@/hooks/use-objects'
import { extractLinkedObjectIds } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
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
	return (
		<div className="mt-2 rounded-lg border border-border bg-card p-3">
			<div className="flex items-center gap-2">
				<TypeBadge type={object.type} label={typeLabel(object.type)} />
				<Link
					to="/$workspaceId/objects/$objectId"
					params={{ workspaceId, objectId: object.id }}
					className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline"
				>
					{object.title || 'Untitled'}
				</Link>
				<StatusBadge status={object.status} className="shrink-0" />
			</div>
			<div className={folded ? 'mt-2 line-clamp-4 text-[13px]' : 'mt-2 text-[13px]'}>
				<MarkdownContent content={body} size="sm" />
			</div>
			{body.length > FOLD_AT ? (
				<button
					type="button"
					onClick={() => setExpanded((open) => !open)}
					className="mt-1 text-xs text-muted-foreground hover:text-foreground"
				>
					{expanded ? 'Show less' : 'Read all'}
				</button>
			) : null}
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
