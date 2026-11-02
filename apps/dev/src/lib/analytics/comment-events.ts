import type { RouteReason, RoutedTo, SessionOrigin } from '../../services/chat-origin-routing'
import { capturePosthogEvent } from './posthog'

interface AgentCommentPostedProps {
	workspaceId: string
	actorId: string
	entityId: string
	entityType: string
	content: string
	hasTaskList: boolean
	/** How the commenting session relates to a chat; see planCommentRouting. */
	sessionOrigin?: SessionOrigin
	hasDecisionBlock?: boolean
	/** Where a human mention ended up: still in For You, moved to a chat, or no human mentioned. */
	routedTo?: RoutedTo
	routeReason?: RouteReason
}

// Detects an opt-in visual fenced block (currently ```chart). Kept as a regex
// so the emit path doesn't depend on a markdown parser — the rendered surface
// uses react-markdown but the analytics signal is deliberately cheaper.
const VISUAL_FENCE_RE = /(^|\n)```chart(\s|\n)/

export async function trackAgentCommentPosted(p: AgentCommentPostedProps): Promise<void> {
	await capturePosthogEvent('agent_comment_posted', p.actorId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		entity_id: p.entityId,
		entity_type: p.entityType,
		char_count: p.content.length,
		has_visual: VISUAL_FENCE_RE.test(p.content),
		has_task_list: p.hasTaskList,
		session_origin: p.sessionOrigin,
		has_decision_block: p.hasDecisionBlock,
		routed_to: p.routedTo,
		route_reason: p.routeReason,
	})
}
