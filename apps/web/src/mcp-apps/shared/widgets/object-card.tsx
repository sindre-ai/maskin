import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { WebAppLink } from '../web-app-link'
import type { ObjectCardProps, WorkspaceSchemaType } from './types'

/**
 * Single-object summary card. The default rendering favors compactness so
 * cards stack well in a chat surface; F7's deep-edit variant will swap in the
 * full `ObjectDocumentView` inside this shell.
 *
 * Schema-aware: when a matching type schema is present we surface its
 * `display_name` next to the type badge so workspaces with custom labels read
 * correctly (e.g. `task` → "Engineering ticket").
 */
export function ObjectCard({ object, schema, handlers, className }: ObjectCardProps) {
	const typeSchema: WorkspaceSchemaType | undefined = schema?.types?.[object.type]
	const displayLabel = typeSchema?.display_name ?? object.type

	return (
		<Card className={cn('p-4 space-y-3', className)}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2">
					<TypeBadge type={displayLabel} />
					<StatusBadge status={object.status} />
				</div>
				<WebAppLink target={{ kind: 'object', id: object.id }} label="Open" />
			</div>
			<h3 className="text-sm font-medium text-foreground leading-tight">
				{object.title || 'Untitled'}
			</h3>
			{object.content && (
				<div className="text-xs text-muted-foreground line-clamp-3">
					<MarkdownContent content={object.content} />
				</div>
			)}
			<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
				{object.updatedAt && <RelativeTime date={object.updatedAt} />}
				{handlers?.onDelete && (
					<button
						type="button"
						onClick={() => handlers.onDelete?.(object.id)}
						className="ml-auto text-destructive hover:underline"
					>
						Delete
					</button>
				)}
			</div>
		</Card>
	)
}
