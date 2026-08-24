/**
 * Pre-v2 conversation thread pane (header + messages + composer), restored
 * from before the v2 Chats redesign. Rendered when the `new-design` flag is
 * OFF — see `routes/_authed/$workspaceId/chats/$conversationId.tsx` for the
 * branch. This whole directory dies with that flag
 * (`.claude/rules/feature-flags.md`).
 */
import { ThreadComposer } from './thread-composer'
import { ThreadHeader } from './thread-header'
import { ThreadMessages } from './thread-messages'

export function LegacyThreadPage({
	workspaceId,
	conversationId,
}: {
	workspaceId: string
	conversationId: string
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ThreadHeader workspaceId={workspaceId} conversationId={conversationId} />
			<ThreadMessages workspaceId={workspaceId} conversationId={conversationId} />
			<div className="border-t border-border p-2">
				<ThreadComposer workspaceId={workspaceId} conversationId={conversationId} />
			</div>
		</div>
	)
}
