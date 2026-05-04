import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { ActionButton, OwnerAction, StatusAction } from '../actions'
import { useToolResult } from '../mcp-app-provider'
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
 *
 * Action affordances are gated on the corresponding handler being present in
 * the parent's `ObjectActionHandlers`. Status / owner edits live next to the
 * badges; delete sits in the bottom-right behind the shared confirmation
 * dialog. See `packages/mcp/ACTIONS.md` for the surface and policy.
 */
export function ObjectCard({ object, schema, handlers, className }: ObjectCardProps) {
	const typeSchema: WorkspaceSchemaType | undefined = schema?.types?.[object.type]
	const displayLabel = typeSchema?.display_name ?? object.type
	const tr = useToolResult()
	const workspaceId = tr?.workspaceId ?? schema?.workspace_id

	return (
		<Card className={cn('p-4 space-y-3', className)}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<TypeBadge type={displayLabel} />
					{handlers?.onUpdateStatus ? (
						<StatusAction
							objectId={object.id}
							objectType={object.type}
							currentStatus={object.status}
							workspaceId={workspaceId}
							onSuccess={(next) => handlers.onUpdateStatus?.(object.id, next)}
						/>
					) : (
						<StatusBadge status={object.status} />
					)}
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
			{handlers?.onUpdateOwner && (
				<OwnerAction
					objectId={object.id}
					currentOwner={object.owner ?? null}
					workspaceId={workspaceId}
					onSuccess={(next) => handlers.onUpdateOwner?.(object.id, next)}
				/>
			)}
			<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
				{object.updatedAt && <RelativeTime date={object.updatedAt} />}
				{handlers?.onDelete && (
					<ActionButton
						kind="object_delete"
						className="ml-auto"
						onRun={() => {
							handlers.onDelete?.(object.id)
						}}
					/>
				)}
			</div>
		</Card>
	)
}
