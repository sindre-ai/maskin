/**
 * Pre-v2 Chats split-pane layout, restored verbatim from before the v2 Chats
 * redesign. Rendered when the `new-design` flag is OFF — see
 * `routes/_authed/$workspaceId/chats.tsx` for the branch. This whole directory
 * dies with that flag (`.claude/rules/feature-flags.md`).
 */
import { useIsMobile } from '@/hooks/use-mobile'
import { useWorkspace } from '@/lib/workspace-context'
import { Outlet, useMatches } from '@tanstack/react-router'
import { ConversationList } from './conversation-list'

// Leaf routes that render a thread pane — on mobile these replace the list
// instead of stacking beside it.
const THREAD_ROUTE_IDS = new Set([
	'/_authed/$workspaceId/chats/$conversationId',
	'/_authed/$workspaceId/chats/new',
])

export function LegacyChatsLayout() {
	const { workspaceId } = useWorkspace()
	const isMobile = useIsMobile()
	const matches = useMatches()
	const leafMatch = matches[matches.length - 1]
	const showThreadOnMobile = !!leafMatch && THREAD_ROUTE_IDS.has(leafMatch.routeId)

	// Full-bleed: reclaim the workspace shell's page padding (`p-4 md:p-8` on
	// `data-scroll-root` in `$workspaceId.tsx`) so the split pane gets the
	// full content width. At exactly 768px (iPad portrait — the narrowest
	// viewport that still gets the two-pane layout), that padding alone was
	// enough to squeeze the thread header's title down to a few visible
	// pixels next to its fixed-width controls (participants pill, pin,
	// archive, copy) — see the known-pitfalls-style regression this fixed.
	if (isMobile) {
		return showThreadOnMobile ? (
			<div className="-m-4 flex min-h-0 flex-1 flex-col">
				<Outlet />
			</div>
		) : (
			<ConversationList workspaceId={workspaceId} className="-m-4" />
		)
	}

	return (
		<div className="-m-4 flex min-h-0 flex-1 md:-m-8">
			<div className="hidden md:flex md:w-64 lg:w-80 shrink-0 flex-col border-r border-border">
				<ConversationList workspaceId={workspaceId} />
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<Outlet />
			</div>
		</div>
	)
}
