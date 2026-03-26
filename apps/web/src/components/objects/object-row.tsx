import type { ObjectResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'

export function ObjectRow({
	object,
	workspaceId,
	indent,
	sessionMap,
}: {
	object: ObjectResponse
	workspaceId: string
	indent?: boolean
	sessionMap?: Map<string, SessionResponse>
}) {
	const activeSession = object.activeSessionId ? sessionMap?.get(object.activeSessionId) : undefined

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			className={cn(
				'flex items-center gap-3 rounded px-3 py-2 hover:bg-muted/50 transition-colors',
				indent && 'pl-8',
			)}
		>
			{indent && <span className="text-muted-foreground text-xs shrink-0">↳</span>}
			<span className="flex-1 min-w-0">
				<span className="block text-sm text-foreground truncate">{object.title || 'Untitled'}</span>
				{activeSession?.actionPrompt && (
					<span className="block text-xs text-muted-foreground truncate">
						{activeSession.actionPrompt}
					</span>
				)}
			</span>
			{object.activeSessionId && <AgentWorkingBadge />}
			<StatusBadge status={object.status} />
			<TypeBadge type={object.type} />
		</Link>
	)
}
