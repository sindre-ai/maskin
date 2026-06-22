import { capturePosthogEvent } from './posthog'

interface AgentCommentPostedProps {
	workspaceId: string
	actorId: string
	entityId: string
	entityType: string
	content: string
	hasTaskList: boolean
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
	})
}
