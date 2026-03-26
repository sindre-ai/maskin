import type { ObjectResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'

export function ObjectRow({
	object,
	workspaceId,
}: {
	object: ObjectResponse
	workspaceId: string
}) {
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			className="flex items-center gap-3 rounded px-3 py-2 hover:bg-muted/50 transition-colors"
		>
			<span className="flex-1 text-sm text-foreground truncate">{object.title || 'Untitled'}</span>
			{object.activeSessionId && (
				<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
			)}
			<StatusBadge status={object.status} />
			<TypeBadge type={object.type} />
		</Link>
	)
}
